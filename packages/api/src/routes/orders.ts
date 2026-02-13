/**
 * Order routes — GET, POST, DELETE for /v1/orders
 */

import type { RouteContext } from "../types.js";
import type { SqlClient } from "../db.js";
import { getSqlClient } from "../db.js";
import { jsonResponse, jsonError } from "../response.js";

// ─── Validation Helpers ─────────────────────────────────────────────────────

const ETH_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const HEX_STRING_RE = /^0x[0-9a-fA-F]+$/;
const VALID_CHAINS = new Set([1, 8453, 84532, 999, 2020, 2741]);
const MAX_BODY_SIZE = 64 * 1024; // 64 KB

function isValidAddress(addr: string): boolean {
  return ETH_ADDRESS_RE.test(addr);
}

function isValidChainId(raw: unknown): raw is number {
  const n = Number(raw);
  return Number.isFinite(n) && VALID_CHAINS.has(n);
}

function safeBigInt(val: unknown): bigint {
  try {
    return BigInt(String(val || "0"));
  } catch {
    return 0n;
  }
}

// ─── Helper: map DB row → API response ──────────────────────────────────────

function mapRowToOrder(row: any) {
  return {
    orderHash: row.order_hash,
    chainId: row.chain_id,
    orderType: row.order_type,
    offerer: row.offerer,
    nftContract: row.nft_contract,
    tokenId: row.token_id,
    tokenStandard: row.token_standard,
    priceWei: row.price_wei,
    currency: row.currency,
    feeRecipient: row.fee_recipient,
    feeBps: row.fee_bps,
    royaltyRecipient: row.royalty_recipient || null,
    royaltyBps: row.royalty_bps || 0,
    startTime: Number(row.start_time),
    endTime: Number(row.end_time),
    status: row.status,
    createdAt: row.created_at,
    filledTxHash: row.filled_tx_hash || null,
    filledAt: row.filled_at || null,
    cancelledTxHash: row.cancelled_tx_hash || null,
    cancelledAt: row.cancelled_at || null,
    orderJson: typeof row.order_json === "string" ? JSON.parse(row.order_json) : row.order_json,
    signature: row.signature,
  };
}

// ─── GET /v1/orders ─────────────────────────────────────────────────────────

export async function handleGetOrders(ctx: RouteContext): Promise<Response> {
  const { params } = ctx;
  const chainIdRaw = params.get("chainId");
  if (!chainIdRaw || !isValidChainId(chainIdRaw)) {
    return jsonError(400, "Missing or invalid chainId parameter");
  }
  const chainId = Number(chainIdRaw);

  const collection = params.get("collection")?.toLowerCase();
  if (collection && !isValidAddress(collection)) {
    return jsonError(400, "Invalid collection address");
  }
  const tokenId = params.get("tokenId");
  const type = params.get("type"); // 'listing' | 'offer'
  const offerer = params.get("offerer")?.toLowerCase();
  if (offerer && !isValidAddress(offerer)) {
    return jsonError(400, "Invalid offerer address");
  }
  const status = params.get("status") || "active";
  const sortBy = params.get("sortBy") || "created_at_desc";
  const limit = Math.min(Math.max(Number(params.get("limit") || 50), 1), 100);
  const offset = Math.max(Number(params.get("offset") || 0), 0);

  const sql = getSqlClient(ctx.env.DATABASE_URL);

  // Validate enum-like inputs
  const validStatuses = ["active", "filled", "cancelled", "expired", "stale"];
  const validTypes = ["listing", "offer"];
  const safeStatus = validStatuses.includes(status) ? status : "active";
  const safeType = type && validTypes.includes(type) ? type : null;

  // Build parameterized query
  const conditions: string[] = [];
  const queryParams: any[] = [];
  let paramIdx = 1;

  conditions.push(`chain_id = $${paramIdx++}`);
  queryParams.push(chainId);

  conditions.push(`status = $${paramIdx++}`);
  queryParams.push(safeStatus);

  if (collection) {
    conditions.push(`nft_contract = $${paramIdx++}`);
    queryParams.push(collection);
  }
  if (tokenId) {
    conditions.push(`token_id = $${paramIdx++}`);
    queryParams.push(tokenId);
  }
  if (safeType) {
    conditions.push(`order_type = $${paramIdx++}`);
    queryParams.push(safeType);
  }
  if (offerer) {
    conditions.push(`offerer = $${paramIdx++}`);
    queryParams.push(offerer);
  }

  // Only return non-expired orders for active status
  if (safeStatus === "active") {
    conditions.push(`end_time > $${paramIdx++}`);
    queryParams.push(Math.floor(Date.now() / 1000));
  }

  let orderClause = "ORDER BY created_at DESC";
  if (sortBy === "price_asc") orderClause = "ORDER BY CAST(price_wei AS NUMERIC) ASC";
  if (sortBy === "price_desc") orderClause = "ORDER BY CAST(price_wei AS NUMERIC) DESC";

  const whereClause = conditions.join(" AND ");

  try {
    const [rows, countResult] = await Promise.all([
      sql(
        `SELECT * FROM seaport_orders WHERE ${whereClause} ${orderClause} LIMIT $${paramIdx++} OFFSET $${paramIdx++}`,
        [...queryParams, limit, offset],
      ),
      sql(
        `SELECT COUNT(*) as total FROM seaport_orders WHERE ${whereClause}`,
        queryParams,
      ),
    ]);

    const total = Number(countResult[0]?.total || 0);
    const orders = rows.map(mapRowToOrder);

    return jsonResponse({ orders, total });
  } catch (err: any) {
    console.error("[oob-api] Failed to fetch orders:", err);
    return jsonError(500, "Failed to fetch orders");
  }
}

// ─── GET /v1/orders/:hash ───────────────────────────────────────────────────

export async function handleGetOrder(ctx: RouteContext): Promise<Response> {
  const orderHash = ctx.segments[2]; // ["v1", "orders", "<hash>"]
  if (!orderHash) return jsonError(400, "Missing order hash");

  const sql = getSqlClient(ctx.env.DATABASE_URL);

  try {
    const rows = await sql`
      SELECT * FROM seaport_orders WHERE order_hash = ${orderHash}
    `;
    if (rows.length === 0) return jsonError(404, "Order not found");

    return jsonResponse({ order: mapRowToOrder(rows[0]) });
  } catch (err: any) {
    console.error("[oob-api] Failed to fetch order:", err);
    return jsonError(500, "Failed to fetch order");
  }
}

// ─── GET /v1/orders/best-listing ────────────────────────────────────────────

export async function handleBestListing(ctx: RouteContext): Promise<Response> {
  const { params } = ctx;
  const chainId = params.get("chainId");
  const collection = params.get("collection")?.toLowerCase();
  const tokenId = params.get("tokenId");

  if (!chainId || !collection) {
    return jsonError(400, "Missing chainId or collection");
  }

  const sql = getSqlClient(ctx.env.DATABASE_URL);
  const now = Math.floor(Date.now() / 1000);

  try {
    let rows;
    if (tokenId) {
      rows = await sql`
        SELECT * FROM seaport_orders
        WHERE chain_id = ${Number(chainId)}
          AND nft_contract = ${collection}
          AND token_id = ${tokenId}
          AND order_type = 'listing'
          AND status = 'active'
          AND end_time > ${now}
        ORDER BY CAST(price_wei AS NUMERIC) ASC
        LIMIT 1
      `;
    } else {
      rows = await sql`
        SELECT * FROM seaport_orders
        WHERE chain_id = ${Number(chainId)}
          AND nft_contract = ${collection}
          AND order_type = 'listing'
          AND status = 'active'
          AND end_time > ${now}
        ORDER BY CAST(price_wei AS NUMERIC) ASC
        LIMIT 1
      `;
    }

    return jsonResponse({ order: rows.length > 0 ? mapRowToOrder(rows[0]) : null });
  } catch (err: any) {
    console.error("[oob-api] Failed to fetch best listing:", err);
    return jsonError(500, "Failed to fetch best listing");
  }
}

// ─── GET /v1/orders/best-offer ──────────────────────────────────────────────

export async function handleBestOffer(ctx: RouteContext): Promise<Response> {
  const { params } = ctx;
  const chainId = params.get("chainId");
  const collection = params.get("collection")?.toLowerCase();
  const tokenId = params.get("tokenId");

  if (!chainId || !collection) {
    return jsonError(400, "Missing chainId or collection");
  }

  const sql = getSqlClient(ctx.env.DATABASE_URL);
  const now = Math.floor(Date.now() / 1000);

  try {
    let rows;
    if (tokenId) {
      rows = await sql`
        SELECT * FROM seaport_orders
        WHERE chain_id = ${Number(chainId)}
          AND nft_contract = ${collection}
          AND token_id = ${tokenId}
          AND order_type = 'offer'
          AND status = 'active'
          AND end_time > ${now}
        ORDER BY CAST(price_wei AS NUMERIC) DESC
        LIMIT 1
      `;
    } else {
      rows = await sql`
        SELECT * FROM seaport_orders
        WHERE chain_id = ${Number(chainId)}
          AND nft_contract = ${collection}
          AND order_type = 'offer'
          AND status = 'active'
          AND end_time > ${now}
        ORDER BY CAST(price_wei AS NUMERIC) DESC
        LIMIT 1
      `;
    }

    return jsonResponse({ order: rows.length > 0 ? mapRowToOrder(rows[0]) : null });
  } catch (err: any) {
    console.error("[oob-api] Failed to fetch best offer:", err);
    return jsonError(500, "Failed to fetch best offer");
  }
}

// ─── POST /v1/orders ────────────────────────────────────────────────────────

export async function handleSubmitOrder(ctx: RouteContext): Promise<Response> {
  // Enforce body size limit to prevent DoS
  const contentLength = Number(ctx.request.headers.get("content-length") || 0);
  if (contentLength > MAX_BODY_SIZE) {
    return jsonError(413, "Request body too large (max 64KB)");
  }

  let body: any;
  try {
    body = await ctx.request.json();
  } catch {
    return jsonError(400, "Invalid JSON body");
  }

  const { chainId, order, signature } = body;
  if (!chainId || !order || !signature) {
    return jsonError(400, "Missing required fields: chainId, order, signature");
  }

  // Validate chain ID
  if (!isValidChainId(chainId)) {
    return jsonError(400, `Unsupported chain ID: ${chainId}`);
  }

  // Validate signature format
  if (typeof signature !== "string" || !HEX_STRING_RE.test(signature)) {
    return jsonError(400, "Invalid signature format");
  }

  // Extract order details from Seaport OrderComponents
  const offerer = (order.offerer || "").toLowerCase();
  const zone = order.zone || "0x0000000000000000000000000000000000000000";
  const startTime = Number(order.startTime || 0);
  const endTime = Number(order.endTime || 0);

  if (!offerer || !isValidAddress(offerer)) {
    return jsonError(400, "Missing or invalid offerer in order");
  }
  if (endTime <= Math.floor(Date.now() / 1000)) {
    return jsonError(400, "Order has already expired");
  }
  // Reject orders with absurdly long durations (> 1 year)
  if (endTime - startTime > 365 * 24 * 60 * 60) {
    return jsonError(400, "Order duration exceeds maximum (1 year)");
  }

  // Verify EIP-712 signature matches offerer
  try {
    const { ethers } = await import("ethers");
    // Reconstruct the EIP-712 domain and types for Seaport v1.6
    const domain = {
      name: "Seaport",
      version: "1.6",
      chainId: Number(chainId),
      verifyingContract: "0x0000000000000068F116a894984e2DB1123eB395",
    };
    const types = {
      OrderComponents: [
        { name: "offerer", type: "address" },
        { name: "zone", type: "address" },
        { name: "offer", type: "OfferItem[]" },
        { name: "consideration", type: "ConsiderationItem[]" },
        { name: "orderType", type: "uint8" },
        { name: "startTime", type: "uint256" },
        { name: "endTime", type: "uint256" },
        { name: "zoneHash", type: "bytes32" },
        { name: "salt", type: "uint256" },
        { name: "conduitKey", type: "bytes32" },
        { name: "counter", type: "uint256" },
      ],
      OfferItem: [
        { name: "itemType", type: "uint8" },
        { name: "token", type: "address" },
        { name: "identifierOrCriteria", type: "uint256" },
        { name: "startAmount", type: "uint256" },
        { name: "endAmount", type: "uint256" },
      ],
      ConsiderationItem: [
        { name: "itemType", type: "uint8" },
        { name: "token", type: "address" },
        { name: "identifierOrCriteria", type: "uint256" },
        { name: "startAmount", type: "uint256" },
        { name: "endAmount", type: "uint256" },
        { name: "recipient", type: "address" },
      ],
    };
    const recovered = ethers.verifyTypedData(domain, types, order, signature);
    if (recovered.toLowerCase() !== offerer) {
      return jsonError(400, "Signature does not match offerer");
    }
  } catch (sigErr: any) {
    return jsonError(400, "Invalid signature: verification failed");
  }

  // Determine order type and extract NFT + price details
  const offerItems: any[] = order.offer || [];
  const considerationItems: any[] = order.consideration || [];

  let orderType: "listing" | "offer";
  let nftContract: string;
  let tokenId: string;
  let tokenStandard: string;
  let priceWei: bigint;
  let currency: string;
  let feeRecipient = "";
  let feeBps = 0;
  let royaltyRecipient = "";
  let royaltyBps = 0;

  // Known fee recipients (OOB treasury)
  const OOB_FEE_RECIPIENT = "0x0000000000000000000000000000000000000001";

  const nftInOffer = offerItems.find(
    (i: any) => Number(i.itemType) === 2 || Number(i.itemType) === 3,
  );
  const nftInConsideration = considerationItems.find(
    (i: any) => Number(i.itemType) === 2 || Number(i.itemType) === 3,
  );

  if (nftInOffer) {
    // LISTING: seller offers NFT, wants payment
    orderType = "listing";
    nftContract = (nftInOffer.token || "").toLowerCase();
    tokenId = String(nftInOffer.identifierOrCriteria || "0");
    tokenStandard = Number(nftInOffer.itemType) === 2 ? "ERC721" : "ERC1155";

    priceWei = 0n;
    currency = "0x0000000000000000000000000000000000000000";

    for (const item of considerationItems) {
      const it = Number(item.itemType);
      if (it === 0 || it === 1) {
        priceWei += safeBigInt(item.startAmount);
        if (it === 1) currency = (item.token || "").toLowerCase();

        const recipient = (item.recipient || "").toLowerCase();
        if (recipient !== offerer) {
          if (recipient === OOB_FEE_RECIPIENT.toLowerCase()) {
            feeRecipient = recipient;
          } else if (!feeRecipient || feeRecipient === OOB_FEE_RECIPIENT.toLowerCase()) {
            // Non-offerer, non-OOB recipient = royalty
            royaltyRecipient = recipient;
          }
        }
      }
    }

    // Calculate fee and royalty BPS
    if (priceWei > 0n) {
      if (feeRecipient) {
        const feeItem = considerationItems.find(
          (i: any) =>
            (i.recipient || "").toLowerCase() === feeRecipient &&
            (Number(i.itemType) === 0 || Number(i.itemType) === 1),
        );
        if (feeItem) {
          const feeAmount = safeBigInt(feeItem.startAmount);
          feeBps = Number((feeAmount * 10000n) / priceWei);
        }
      }
      if (royaltyRecipient) {
        const royaltyItem = considerationItems.find(
          (i: any) =>
            (i.recipient || "").toLowerCase() === royaltyRecipient &&
            (Number(i.itemType) === 0 || Number(i.itemType) === 1),
        );
        if (royaltyItem) {
          const royaltyAmount = safeBigInt(royaltyItem.startAmount);
          royaltyBps = Number((royaltyAmount * 10000n) / priceWei);
        }
      }
    }
  } else if (nftInConsideration) {
    // OFFER: bidder offers ERC20, wants NFT
    orderType = "offer";
    nftContract = (nftInConsideration.token || "").toLowerCase();
    tokenId = String(nftInConsideration.identifierOrCriteria || "0");
    tokenStandard = Number(nftInConsideration.itemType) === 2 ? "ERC721" : "ERC1155";

    priceWei = 0n;
    currency = "0x0000000000000000000000000000000000000000";
    for (const item of offerItems) {
      const it = Number(item.itemType);
      if (it === 0 || it === 1) {
        priceWei += safeBigInt(item.startAmount);
        if (it === 1) currency = (item.token || "").toLowerCase();
      }
    }

    // Fee/royalty from consideration (non-NFT items going to non-offerer)
    for (const item of considerationItems) {
      const it = Number(item.itemType);
      if ((it === 0 || it === 1) && (item.recipient || "").toLowerCase() !== offerer) {
        const recipient = (item.recipient || "").toLowerCase();
        const amount = safeBigInt(item.startAmount);
        if (recipient === OOB_FEE_RECIPIENT.toLowerCase()) {
          feeRecipient = recipient;
          if (priceWei > 0n) feeBps = Number((amount * 10000n) / priceWei);
        } else {
          royaltyRecipient = recipient;
          if (priceWei > 0n) royaltyBps = Number((amount * 10000n) / priceWei);
        }
      }
    }
  } else {
    return jsonError(400, "Order must contain an NFT in offer or consideration");
  }

  if (!nftContract) return jsonError(400, "Could not extract NFT contract from order");
  if (!isValidAddress(nftContract)) return jsonError(400, "Invalid NFT contract address in order");
  if (priceWei <= 0n) return jsonError(400, "Order price must be greater than zero");

  // Compute order hash
  const { ethers } = await import("ethers");
  const orderHash = ethers.keccak256(
    ethers.toUtf8Bytes(JSON.stringify(order) + signature),
  );

  const sql = getSqlClient(ctx.env.DATABASE_URL);

  try {
    // Check for duplicate
    const existing = await sql`
      SELECT order_hash FROM seaport_orders WHERE order_hash = ${orderHash}
    `;
    if (existing.length > 0) {
      return jsonResponse({ orderHash, status: "active", duplicate: true });
    }

    await sql`
      INSERT INTO seaport_orders (
        order_hash, chain_id, order_type, offerer, zone,
        nft_contract, token_id, token_standard,
        price_wei, currency,
        fee_recipient, fee_bps,
        royalty_recipient, royalty_bps,
        order_json, signature,
        start_time, end_time,
        status
      ) VALUES (
        ${orderHash}, ${Number(chainId)}, ${orderType}, ${offerer}, ${zone},
        ${nftContract}, ${tokenId}, ${tokenStandard},
        ${priceWei.toString()}, ${currency},
        ${feeRecipient}, ${feeBps},
        ${royaltyRecipient || null}, ${royaltyBps},
        ${JSON.stringify(order)}, ${signature},
        ${startTime}, ${endTime},
        'active'
      )
    `;

    return jsonResponse({ orderHash, status: "active" }, 201);
  } catch (err: any) {
    console.error("[oob-api] Failed to insert order:", err);
    return jsonError(500, "Failed to store order");
  }
}

// ─── DELETE /v1/orders/:hash ────────────────────────────────────────────────

export async function handleCancelOrder(ctx: RouteContext): Promise<Response> {
  const orderHash = ctx.segments[2];
  if (!orderHash) return jsonError(400, "Missing order hash");
  if (!HEX_STRING_RE.test(orderHash)) return jsonError(400, "Invalid order hash format");

  let body: any = {};
  try {
    body = await ctx.request.json();
  } catch {
    // body is optional for cancel
  }

  const txHash = body?.txHash || null;
  if (txHash && (typeof txHash !== "string" || !HEX_STRING_RE.test(txHash))) {
    return jsonError(400, "Invalid txHash format");
  }

  const sql = getSqlClient(ctx.env.DATABASE_URL);

  // Require on-chain proof: only cancel if a valid tx hash is provided.
  // Without this, anyone could hide orders from the API.
  // The indexer can also cancel orders when it detects on-chain cancellation events.
  if (!txHash) {
    return jsonError(400, "txHash is required to cancel an order. Cancel on-chain first, then provide the transaction hash.");
  }

  try {
    const result = await sql`
      UPDATE seaport_orders
      SET status = 'cancelled',
          cancelled_tx_hash = ${txHash},
          cancelled_at = NOW()
      WHERE order_hash = ${orderHash}
        AND status = 'active'
      RETURNING order_hash
    `;

    if (result.length === 0) {
      return jsonError(404, "Order not found or already cancelled/filled");
    }

    return jsonResponse({ orderHash, status: "cancelled" });
  } catch (err: any) {
    console.error("[oob-api] Failed to cancel order:", err);
    return jsonError(500, "Failed to cancel order");
  }
}

// ─── GET /v1/collections/:address/stats ─────────────────────────────────────

export async function handleCollectionStats(ctx: RouteContext): Promise<Response> {
  const { params } = ctx;
  const chainId = params.get("chainId");
  const collection = ctx.segments[2]?.toLowerCase(); // ["v1", "collections", "<address>", "stats"]

  if (!chainId || !collection) {
    return jsonError(400, "Missing chainId or collection address");
  }

  const sql = getSqlClient(ctx.env.DATABASE_URL);
  const now = Math.floor(Date.now() / 1000);

  try {
    const [listingStats, offerStats] = await Promise.all([
      sql`
        SELECT
          COUNT(*) as listing_count,
          MIN(CAST(price_wei AS NUMERIC)) as floor_price_wei
        FROM seaport_orders
        WHERE chain_id = ${Number(chainId)}
          AND nft_contract = ${collection}
          AND order_type = 'listing'
          AND status = 'active'
          AND end_time > ${now}
      `,
      sql`
        SELECT
          COUNT(*) as offer_count,
          MAX(CAST(price_wei AS NUMERIC)) as best_offer_wei
        FROM seaport_orders
        WHERE chain_id = ${Number(chainId)}
          AND nft_contract = ${collection}
          AND order_type = 'offer'
          AND status = 'active'
          AND end_time > ${now}
      `,
    ]);

    return jsonResponse({
      collection,
      chainId: Number(chainId),
      listingCount: Number(listingStats[0]?.listing_count || 0),
      floorPriceWei: listingStats[0]?.floor_price_wei?.toString() || null,
      offerCount: Number(offerStats[0]?.offer_count || 0),
      bestOfferWei: offerStats[0]?.best_offer_wei?.toString() || null,
    });
  } catch (err: any) {
    console.error("[oob-api] Failed to fetch collection stats:", err);
    return jsonError(500, "Failed to fetch collection stats");
  }
}
