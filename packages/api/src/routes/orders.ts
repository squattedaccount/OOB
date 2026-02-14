/**
 * Order routes — GET, POST, DELETE for /v1/orders
 */

import type { RouteContext } from "../types.js";
import type { SqlClient } from "../db.js";
import { getSqlClient } from "../db.js";
import { jsonResponse, jsonError } from "../response.js";
import { computeOrderHash } from "../seaportHash.js";
import { logActivity } from "../activity.js";

// ─── Validation Helpers ─────────────────────────────────────────────────────

const ETH_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const HEX_STRING_RE = /^0x[0-9a-fA-F]+$/;
const VALID_CHAINS = new Set([1, 8453, 84532, 999, 2020, 202601, 2741]);
const MAX_BODY_SIZE = 64 * 1024; // 64 KB
const MAX_ACTIVE_ORDERS_PER_OFFERER = 500;

function isValidAddress(addr: string): boolean {
  return ETH_ADDRESS_RE.test(addr);
}

function isValidChainId(raw: unknown): raw is number {
  const n = Number(raw);
  return Number.isFinite(n) && VALID_CHAINS.has(n);
}

const MAX_BATCH_SIZE = 20;

/**
 * Read request body as text with a hard byte-size limit.
 * Rejects if the actual body exceeds maxBytes, regardless of content-length header.
 */
async function readBodyWithLimit(request: Request, maxBytes: number): Promise<string> {
  const reader = request.body?.getReader();
  if (!reader) throw new Error("No body");

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > maxBytes) {
      reader.cancel();
      throw new Error("BODY_TOO_LARGE");
    }
    chunks.push(value);
  }

  const merged = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

function safeBigInt(val: unknown): bigint {
  try {
    return BigInt(String(val || "0"));
  } catch {
    return 0n;
  }
}

// ─── Fee Enforcement ────────────────────────────────────────────────────────

/**
 * Validate that a submitted order includes our fee recipient with at least
 * the minimum required fee. Returns null if valid, or an error string.
 */
function validateFeeEnforcement(
  order: any,
  env: { PROTOCOL_FEE_RECIPIENT: string; PROTOCOL_FEE_BPS?: string },
): string | null {
  const requiredRecipient = (env.PROTOCOL_FEE_RECIPIENT || "").toLowerCase();
  if (!requiredRecipient || !ETH_ADDRESS_RE.test(requiredRecipient)) {
    return "Protocol fee enforcement is not configured";
  }

  const minFeeBps = Number(env.PROTOCOL_FEE_BPS || "50"); // default 0.5%
  if (minFeeBps <= 0) {
    return "Protocol fee BPS must be greater than zero";
  }

  const offerItems: any[] = order.offer || [];
  const considerationItems: any[] = order.consideration || [];

  // Reject variable amount (ascending/descending) orders for fungible items.
  // We require fixed prices to ensure fee enforcement is correct at fill time.
  for (const item of [...offerItems, ...considerationItems]) {
    const it = Number(item?.itemType);
    if (it === 0 || it === 1) {
      const start = String(item?.startAmount ?? "0");
      const end = String(item?.endAmount ?? "0");
      if (start !== end) {
        return "Fungible items must have startAmount === endAmount";
      }
    }
  }

  // Enforce single payment currency: all fungible items must share the same (itemType, token).
  // Prevents fee bypass via inflated junk-token amounts.
  let paymentItemType: number | null = null;
  let paymentToken: string | null = null;
  for (const item of [...offerItems, ...considerationItems]) {
    const it = Number(item?.itemType);
    if (it === 0 || it === 1) {
      const token = (item.token || "0x0000000000000000000000000000000000000000").toLowerCase();
      if (paymentItemType === null) {
        paymentItemType = it;
        paymentToken = token;
      } else if (it !== paymentItemType || token !== paymentToken) {
        return "All fungible items must use the same payment currency";
      }
    }
  }

  // Determine total price from the order
  const nftInOffer = offerItems.find(
    (i: any) => Number(i.itemType) === 2 || Number(i.itemType) === 3,
  );
  const nftInConsideration = considerationItems.find(
    (i: any) => Number(i.itemType) === 2 || Number(i.itemType) === 3,
  );

  let totalPriceWei = 0n;
  let feeAmountWei = 0n;

  if (nftInOffer) {
    // LISTING: price is sum of all native/ERC20 consideration items
    for (const item of considerationItems) {
      const it = Number(item.itemType);
      if (it === 0 || it === 1) {
        totalPriceWei += safeBigInt(item.startAmount);
        if ((item.recipient || "").toLowerCase() === requiredRecipient) {
          feeAmountWei += safeBigInt(item.startAmount);
        }
      }
    }
  } else if (nftInConsideration) {
    // OFFER: price is sum of all native/ERC20 offer items
    for (const item of offerItems) {
      const it = Number(item.itemType);
      if (it === 0 || it === 1) {
        totalPriceWei += safeBigInt(item.startAmount);
      }
    }
    // Fee for offers is in consideration (non-NFT items going to fee recipient)
    for (const item of considerationItems) {
      const it = Number(item.itemType);
      if ((it === 0 || it === 1) && (item.recipient || "").toLowerCase() === requiredRecipient) {
        feeAmountWei += safeBigInt(item.startAmount);
      }
    }
  }

  if (totalPriceWei <= 0n) {
    return null; // price validation happens elsewhere
  }

  if (feeAmountWei <= 0n) {
    return `Order must include a fee payment to ${requiredRecipient} (minimum ${minFeeBps / 100}%)`;
  }

  // Check fee meets minimum BPS
  const actualBps = Number((feeAmountWei * 10000n) / totalPriceWei);
  if (actualBps < minFeeBps) {
    return `Fee too low: ${actualBps} bps (minimum ${minFeeBps} bps / ${minFeeBps / 100}%). Fee recipient: ${requiredRecipient}`;
  }

  return null; // valid
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
  if (!HEX_STRING_RE.test(orderHash)) return jsonError(400, "Invalid order hash format");

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
  // Enforce actual body size limit (not just content-length header which can be spoofed/omitted)
  let rawBody: string;
  try {
    rawBody = await readBodyWithLimit(ctx.request, MAX_BODY_SIZE);
  } catch (err: any) {
    if (err.message === "BODY_TOO_LARGE") return jsonError(413, "Request body too large (max 64KB)");
    return jsonError(400, "Failed to read request body");
  }

  let body: any;
  try {
    body = JSON.parse(rawBody);
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

  // Reject non-FULL_OPEN order types (partial fills not supported)
  if (Number(order.orderType) !== 0) {
    return jsonError(400, "Only FULL_OPEN orders (orderType 0) are supported");
  }

  // ── Fee enforcement: reject orders that don't include our fee ──
  const feeError = validateFeeEnforcement(order, ctx.env);
  if (feeError) {
    return jsonError(400, feeError);
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

  // Protocol fee recipient from env (server-enforced)
  const OOB_FEE_RECIPIENT = (ctx.env.PROTOCOL_FEE_RECIPIENT || "0x0000000000000000000000000000000000000001").toLowerCase();

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

  // Compute the real Seaport EIP-712 order hash (matches on-chain events)
  const orderHash = computeOrderHash(order, Number(chainId));

  const sql = getSqlClient(ctx.env.DATABASE_URL);

  try {
    // Check for duplicate
    const existing = await sql`
      SELECT order_hash FROM seaport_orders WHERE order_hash = ${orderHash}
    `;
    if (existing.length > 0) {
      return jsonResponse({ orderHash, status: "active", duplicate: true });
    }

    // Per-offerer active order limit (prevent DB spam)
    const activeCount = await sql`
      SELECT COUNT(*)::int as cnt FROM seaport_orders
      WHERE offerer = ${offerer} AND status = 'active'
    `;
    if (Number(activeCount[0]?.cnt || 0) >= MAX_ACTIVE_ORDERS_PER_OFFERER) {
      return jsonError(429, `Too many active orders for this offerer (max ${MAX_ACTIVE_ORDERS_PER_OFFERER})`);
    }

    // Prevent duplicate active listings for the same token by the same offerer
    if (orderType === "listing") {
      const dupListing = await sql`
        SELECT order_hash FROM seaport_orders
        WHERE offerer = ${offerer}
          AND chain_id = ${Number(chainId)}
          AND nft_contract = ${nftContract}
          AND token_id = ${tokenId}
          AND order_type = 'listing'
          AND status = 'active'
        LIMIT 1
      `;
      if (dupListing.length > 0) {
        return jsonError(409, "Active listing already exists for this token. Cancel the existing one first.");
      }
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

    // Log activity
    await logActivity(sql, {
      orderHash,
      chainId: Number(chainId),
      eventType: orderType === "listing" ? "listed" : "offer_placed",
      fromAddress: offerer,
      nftContract,
      tokenId,
      priceWei: priceWei.toString(),
      currency,
    });

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
    const raw = await readBodyWithLimit(ctx.request, 16 * 1024); // 16KB max for cancel
    body = JSON.parse(raw);
  } catch (err: any) {
    if (err.message === "BODY_TOO_LARGE") return jsonError(413, "Request body too large");
    // body parse failure is OK — signature may be missing, handled below
  }

  const sql = getSqlClient(ctx.env.DATABASE_URL);

  // Look up the order to verify the caller is the offerer
  const orderRows = await sql`
    SELECT offerer, status, chain_id, nft_contract, token_id, price_wei FROM seaport_orders WHERE order_hash = ${orderHash}
  `;
  if (orderRows.length === 0) {
    return jsonError(404, "Order not found");
  }
  if (orderRows[0].status !== "active") {
    return jsonError(409, `Order is already ${orderRows[0].status}`);
  }

  // Only offerer-signed cancellation is allowed via the API.
  // On-chain cancellations are detected automatically by the indexer webhook.
  const { signature: cancelSig } = body;

  if (!cancelSig) {
    return jsonError(400, "Missing cancel signature. Sign the message 'cancel:<orderHash>' with the offerer wallet.");
  }

  // Verify EIP-191 personal_sign: sign("cancel:" + orderHash)
  try {
    const { ethers } = await import("ethers");
    const message = `cancel:${orderHash}`;
    const recovered = ethers.verifyMessage(message, cancelSig);
    if (recovered.toLowerCase() !== orderRows[0].offerer.toLowerCase()) {
      return jsonError(403, "Cancel signature does not match order offerer");
    }
  } catch {
    return jsonError(400, "Invalid cancel signature");
  }

  try {
    const result = await sql`
      UPDATE seaport_orders
      SET status = 'cancelled',
          cancelled_at = NOW()
      WHERE order_hash = ${orderHash}
        AND status = 'active'
      RETURNING order_hash
    `;

    if (result.length === 0) {
      return jsonError(404, "Order not found or already cancelled/filled");
    }

    // Log activity
    await logActivity(sql, {
      orderHash,
      chainId: orderRows[0].chain_id || 0,
      eventType: "cancelled",
      fromAddress: orderRows[0].offerer,
      nftContract: orderRows[0].nft_contract,
      tokenId: orderRows[0].token_id,
      priceWei: orderRows[0].price_wei,
      txHash: null,
    });

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

// ─── GET /v1/activity ─────────────────────────────────────────────────────

export async function handleGetActivity(ctx: RouteContext): Promise<Response> {
  const { params } = ctx;
  const chainIdRaw = params.get("chainId");
  if (!chainIdRaw || !isValidChainId(chainIdRaw)) {
    return jsonError(400, "Missing or invalid chainId parameter");
  }
  const chainId = Number(chainIdRaw);

  const collection = params.get("collection")?.toLowerCase();
  const tokenId = params.get("tokenId");
  const orderHash = params.get("orderHash");
  const eventType = params.get("eventType");
  const address = params.get("address")?.toLowerCase(); // from or to
  const limit = Math.min(Math.max(Number(params.get("limit") || 50), 1), 200);
  const offset = Math.max(Number(params.get("offset") || 0), 0);

  const sql = getSqlClient(ctx.env.DATABASE_URL);

  const conditions: string[] = [];
  const queryParams: any[] = [];
  let paramIdx = 1;

  conditions.push(`chain_id = $${paramIdx++}`);
  queryParams.push(chainId);

  if (collection) {
    conditions.push(`nft_contract = $${paramIdx++}`);
    queryParams.push(collection);
  }
  if (tokenId) {
    conditions.push(`token_id = $${paramIdx++}`);
    queryParams.push(tokenId);
  }
  if (orderHash) {
    conditions.push(`order_hash = $${paramIdx++}`);
    queryParams.push(orderHash);
  }
  if (eventType) {
    const validTypes = ["listed", "offer_placed", "filled", "cancelled", "expired", "stale"];
    if (validTypes.includes(eventType)) {
      conditions.push(`event_type = $${paramIdx++}`);
      queryParams.push(eventType);
    }
  }
  if (address) {
    conditions.push(`(from_address = $${paramIdx} OR to_address = $${paramIdx})`);
    queryParams.push(address);
    paramIdx++;
  }

  const whereClause = conditions.join(" AND ");

  try {
    const [rows, countResult] = await Promise.all([
      sql(
        `SELECT * FROM order_activity WHERE ${whereClause} ORDER BY created_at DESC LIMIT $${paramIdx++} OFFSET $${paramIdx++}`,
        [...queryParams, limit, offset],
      ),
      sql(
        `SELECT COUNT(*) as total FROM order_activity WHERE ${whereClause}`,
        queryParams,
      ),
    ]);

    const total = Number(countResult[0]?.total || 0);
    const activity = rows.map((r: any) => ({
      id: r.id,
      orderHash: r.order_hash,
      chainId: r.chain_id,
      eventType: r.event_type,
      fromAddress: r.from_address,
      toAddress: r.to_address,
      nftContract: r.nft_contract,
      tokenId: r.token_id,
      priceWei: r.price_wei,
      currency: r.currency,
      txHash: r.tx_hash,
      createdAt: r.created_at,
    }));

    return jsonResponse({ activity, total });
  } catch (err: any) {
    console.error("[oob-api] Failed to fetch activity:", err);
    return jsonError(500, "Failed to fetch activity");
  }
}

// ─── POST /v1/orders/batch ──────────────────────────────────────────────────

interface BatchOrderInput {
  chainId: number;
  order: any;
  signature: string;
}

interface BatchSubmitResult {
  orderHash: string;
  status: string;
  error?: string;
  duplicate?: boolean;
}

export async function handleBatchSubmitOrders(ctx: RouteContext): Promise<Response> {
  const maxBatchBody = MAX_BODY_SIZE * MAX_BATCH_SIZE;
  let rawBody: string;
  try {
    rawBody = await readBodyWithLimit(ctx.request, maxBatchBody);
  } catch (err: any) {
    if (err.message === "BODY_TOO_LARGE") return jsonError(413, `Request body too large (max ${maxBatchBody / 1024}KB)`);
    return jsonError(400, "Failed to read request body");
  }

  let body: any;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return jsonError(400, "Invalid JSON body");
  }

  const { orders } = body;
  if (!Array.isArray(orders) || orders.length === 0) {
    return jsonError(400, "Missing or empty 'orders' array");
  }
  if (orders.length > MAX_BATCH_SIZE) {
    return jsonError(400, `Batch size exceeds maximum (${MAX_BATCH_SIZE})`);
  }

  const sql = getSqlClient(ctx.env.DATABASE_URL);
  const results: BatchSubmitResult[] = [];

  for (const item of orders as BatchOrderInput[]) {
    try {
      const result = await processSingleOrderSubmit(sql, item, ctx.env);
      results.push(result);
    } catch (err: any) {
      results.push({
        orderHash: "",
        status: "error",
        error: err.message || "Unknown error",
      });
    }
  }

  const succeeded = results.filter((r) => r.status !== "error").length;
  const failed = results.filter((r) => r.status === "error").length;

  return jsonResponse({ results, succeeded, failed, total: results.length }, succeeded > 0 ? 201 : 400);
}

async function processSingleOrderSubmit(
  sql: SqlClient,
  item: BatchOrderInput,
  env: { PROTOCOL_FEE_RECIPIENT: string; PROTOCOL_FEE_BPS?: string },
): Promise<BatchSubmitResult> {
  const { chainId, order, signature } = item;

  if (!chainId || !order || !signature) {
    return { orderHash: "", status: "error", error: "Missing required fields: chainId, order, signature" };
  }
  if (!isValidChainId(chainId)) {
    return { orderHash: "", status: "error", error: `Unsupported chain ID: ${chainId}` };
  }
  if (typeof signature !== "string" || !HEX_STRING_RE.test(signature)) {
    return { orderHash: "", status: "error", error: "Invalid signature format" };
  }

  const offerer = (order.offerer || "").toLowerCase();
  const startTime = Number(order.startTime || 0);
  const endTime = Number(order.endTime || 0);

  if (!offerer || !isValidAddress(offerer)) {
    return { orderHash: "", status: "error", error: "Missing or invalid offerer" };
  }
  if (endTime <= Math.floor(Date.now() / 1000)) {
    return { orderHash: "", status: "error", error: "Order has already expired" };
  }
  // Reject absurdly long durations (> 1 year)
  if (endTime - startTime > 365 * 24 * 60 * 60) {
    return { orderHash: "", status: "error", error: "Order duration exceeds maximum (1 year)" };
  }
  // Reject non-FULL_OPEN order types (partial fills not supported)
  if (Number(order.orderType) !== 0) {
    return { orderHash: "", status: "error", error: "Only FULL_OPEN orders (orderType 0) are supported" };
  }

  // Verify EIP-712 signature
  try {
    const { ethers } = await import("ethers");
    const domain = {
      name: "Seaport", version: "1.6",
      chainId: Number(chainId),
      verifyingContract: "0x0000000000000068F116a894984e2DB1123eB395",
    };
    const types = {
      OrderComponents: [
        { name: "offerer", type: "address" }, { name: "zone", type: "address" },
        { name: "offer", type: "OfferItem[]" }, { name: "consideration", type: "ConsiderationItem[]" },
        { name: "orderType", type: "uint8" }, { name: "startTime", type: "uint256" },
        { name: "endTime", type: "uint256" }, { name: "zoneHash", type: "bytes32" },
        { name: "salt", type: "uint256" }, { name: "conduitKey", type: "bytes32" },
        { name: "counter", type: "uint256" },
      ],
      OfferItem: [
        { name: "itemType", type: "uint8" }, { name: "token", type: "address" },
        { name: "identifierOrCriteria", type: "uint256" }, { name: "startAmount", type: "uint256" },
        { name: "endAmount", type: "uint256" },
      ],
      ConsiderationItem: [
        { name: "itemType", type: "uint8" }, { name: "token", type: "address" },
        { name: "identifierOrCriteria", type: "uint256" }, { name: "startAmount", type: "uint256" },
        { name: "endAmount", type: "uint256" }, { name: "recipient", type: "address" },
      ],
    };
    const recovered = ethers.verifyTypedData(domain, types, order, signature);
    if (recovered.toLowerCase() !== offerer) {
      return { orderHash: "", status: "error", error: "Signature does not match offerer" };
    }
  } catch {
    return { orderHash: "", status: "error", error: "Invalid signature: verification failed" };
  }

  // Fee enforcement
  const feeError = validateFeeEnforcement(order, env);
  if (feeError) {
    return { orderHash: "", status: "error", error: feeError };
  }

  // Extract NFT + price details
  const offerItems: any[] = order.offer || [];
  const considerationItems: any[] = order.consideration || [];
  const OOB_FEE_RECIPIENT = (env.PROTOCOL_FEE_RECIPIENT || "0x0000000000000000000000000000000000000001").toLowerCase();

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

  const nftInOffer = offerItems.find((i: any) => Number(i.itemType) === 2 || Number(i.itemType) === 3);
  const nftInConsideration = considerationItems.find((i: any) => Number(i.itemType) === 2 || Number(i.itemType) === 3);

  if (nftInOffer) {
    orderType = "listing";
    nftContract = (nftInOffer.token || "").toLowerCase();
    tokenId = String(nftInOffer.identifierOrCriteria || "0");
    tokenStandard = Number(nftInOffer.itemType) === 2 ? "ERC721" : "ERC1155";
    priceWei = 0n;
    currency = "0x0000000000000000000000000000000000000000";
    for (const ci of considerationItems) {
      const it = Number(ci.itemType);
      if (it === 0 || it === 1) {
        priceWei += safeBigInt(ci.startAmount);
        if (it === 1) currency = (ci.token || "").toLowerCase();
        const recipient = (ci.recipient || "").toLowerCase();
        if (recipient !== offerer) {
          if (recipient === OOB_FEE_RECIPIENT.toLowerCase()) feeRecipient = recipient;
          else royaltyRecipient = recipient;
        }
      }
    }
    if (priceWei > 0n && feeRecipient) {
      const feeItem = considerationItems.find((i: any) => (i.recipient || "").toLowerCase() === feeRecipient && (Number(i.itemType) === 0 || Number(i.itemType) === 1));
      if (feeItem) feeBps = Number((safeBigInt(feeItem.startAmount) * 10000n) / priceWei);
    }
    if (priceWei > 0n && royaltyRecipient) {
      const royaltyItem = considerationItems.find((i: any) => (i.recipient || "").toLowerCase() === royaltyRecipient && (Number(i.itemType) === 0 || Number(i.itemType) === 1));
      if (royaltyItem) royaltyBps = Number((safeBigInt(royaltyItem.startAmount) * 10000n) / priceWei);
    }
  } else if (nftInConsideration) {
    orderType = "offer";
    nftContract = (nftInConsideration.token || "").toLowerCase();
    tokenId = String(nftInConsideration.identifierOrCriteria || "0");
    tokenStandard = Number(nftInConsideration.itemType) === 2 ? "ERC721" : "ERC1155";
    priceWei = 0n;
    currency = "0x0000000000000000000000000000000000000000";
    for (const oi of offerItems) {
      const it = Number(oi.itemType);
      if (it === 0 || it === 1) {
        priceWei += safeBigInt(oi.startAmount);
        if (it === 1) currency = (oi.token || "").toLowerCase();
      }
    }
  } else {
    return { orderHash: "", status: "error", error: "Order must contain an NFT in offer or consideration" };
  }

  if (!nftContract || !isValidAddress(nftContract)) {
    return { orderHash: "", status: "error", error: "Invalid NFT contract address" };
  }
  if (priceWei <= 0n) {
    return { orderHash: "", status: "error", error: "Order price must be greater than zero" };
  }

  const orderHash = computeOrderHash(order, Number(chainId));

  // Check duplicate
  const existing = await sql`SELECT order_hash FROM seaport_orders WHERE order_hash = ${orderHash}`;
  if (existing.length > 0) {
    return { orderHash, status: "active", duplicate: true };
  }

  // Per-offerer active order limit (prevent DB spam)
  const activeCount = await sql`
    SELECT COUNT(*)::int as cnt FROM seaport_orders
    WHERE offerer = ${offerer} AND status = 'active'
  `;
  if (Number(activeCount[0]?.cnt || 0) >= MAX_ACTIVE_ORDERS_PER_OFFERER) {
    return { orderHash, status: "error", error: `Too many active orders for this offerer (max ${MAX_ACTIVE_ORDERS_PER_OFFERER})` };
  }

  // Duplicate listing check
  if (orderType === "listing") {
    const dupListing = await sql`
      SELECT order_hash FROM seaport_orders
      WHERE offerer = ${offerer} AND chain_id = ${Number(chainId)}
        AND nft_contract = ${nftContract} AND token_id = ${tokenId}
        AND order_type = 'listing' AND status = 'active'
      LIMIT 1
    `;
    if (dupListing.length > 0) {
      return { orderHash, status: "error", error: "Active listing already exists for this token" };
    }
  }

  const zone = order.zone || "0x0000000000000000000000000000000000000000";

  await sql`
    INSERT INTO seaport_orders (
      order_hash, chain_id, order_type, offerer, zone,
      nft_contract, token_id, token_standard,
      price_wei, currency,
      fee_recipient, fee_bps,
      royalty_recipient, royalty_bps,
      order_json, signature,
      start_time, end_time, status
    ) VALUES (
      ${orderHash}, ${Number(chainId)}, ${orderType}, ${offerer}, ${zone},
      ${nftContract}, ${tokenId}, ${tokenStandard},
      ${priceWei.toString()}, ${currency},
      ${feeRecipient}, ${feeBps},
      ${royaltyRecipient || null}, ${royaltyBps},
      ${JSON.stringify(order)}, ${signature},
      ${startTime}, ${endTime}, 'active'
    )
  `;

  await logActivity(sql, {
    orderHash,
    chainId: Number(chainId),
    eventType: orderType === "listing" ? "listed" : "offer_placed",
    fromAddress: offerer,
    nftContract, tokenId,
    priceWei: priceWei.toString(),
    currency,
  });

  return { orderHash, status: "active" };
}

// ─── DELETE /v1/orders/batch ────────────────────────────────────────────────

interface BatchCancelInput {
  orderHash: string;
  signature: string;
}

interface BatchCancelResult {
  orderHash: string;
  status: string;
  error?: string;
}

export async function handleBatchCancelOrders(ctx: RouteContext): Promise<Response> {
  let body: any;
  try {
    const raw = await readBodyWithLimit(ctx.request, MAX_BODY_SIZE); // 64KB max
    body = JSON.parse(raw);
  } catch (err: any) {
    if (err.message === "BODY_TOO_LARGE") return jsonError(413, "Request body too large");
    return jsonError(400, "Invalid JSON body");
  }

  const { cancellations } = body;
  if (!Array.isArray(cancellations) || cancellations.length === 0) {
    return jsonError(400, "Missing or empty 'cancellations' array");
  }
  if (cancellations.length > MAX_BATCH_SIZE) {
    return jsonError(400, `Batch size exceeds maximum (${MAX_BATCH_SIZE})`);
  }

  const sql = getSqlClient(ctx.env.DATABASE_URL);
  const results: BatchCancelResult[] = [];

  for (const item of cancellations as BatchCancelInput[]) {
    try {
      const result = await processSingleOrderCancel(sql, item);
      results.push(result);
    } catch (err: any) {
      results.push({
        orderHash: item.orderHash || "",
        status: "error",
        error: err.message || "Unknown error",
      });
    }
  }

  const succeeded = results.filter((r) => r.status === "cancelled").length;
  const failed = results.filter((r) => r.status === "error").length;

  return jsonResponse({ results, succeeded, failed, total: results.length });
}

async function processSingleOrderCancel(
  sql: SqlClient,
  item: BatchCancelInput,
): Promise<BatchCancelResult> {
  const { orderHash, signature: cancelSig } = item;

  if (!orderHash || !HEX_STRING_RE.test(orderHash)) {
    return { orderHash: orderHash || "", status: "error", error: "Invalid order hash" };
  }

  if (!cancelSig) {
    return { orderHash, status: "error", error: "Missing cancel signature" };
  }

  const orderRows = await sql`
    SELECT offerer, status, chain_id, nft_contract, token_id, price_wei
    FROM seaport_orders WHERE order_hash = ${orderHash}
  `;
  if (orderRows.length === 0) {
    return { orderHash, status: "error", error: "Order not found" };
  }
  if (orderRows[0].status !== "active") {
    return { orderHash, status: "error", error: `Order is already ${orderRows[0].status}` };
  }

  try {
    const { ethers } = await import("ethers");
    const message = `cancel:${orderHash}`;
    const recovered = ethers.verifyMessage(message, cancelSig);
    if (recovered.toLowerCase() !== orderRows[0].offerer.toLowerCase()) {
      return { orderHash, status: "error", error: "Cancel signature does not match offerer" };
    }
  } catch {
    return { orderHash, status: "error", error: "Invalid cancel signature" };
  }

  const result = await sql`
    UPDATE seaport_orders
    SET status = 'cancelled', cancelled_at = NOW()
    WHERE order_hash = ${orderHash} AND status = 'active'
    RETURNING order_hash
  `;

  if (result.length === 0) {
    return { orderHash, status: "error", error: "Order not found or already cancelled/filled" };
  }

  await logActivity(sql, {
    orderHash,
    chainId: orderRows[0].chain_id || 0,
    eventType: "cancelled",
    fromAddress: orderRows[0].offerer,
    nftContract: orderRows[0].nft_contract,
    tokenId: orderRows[0].token_id,
    priceWei: orderRows[0].price_wei,
    txHash: null,
  });

  return { orderHash, status: "cancelled" };
}
