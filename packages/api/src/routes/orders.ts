/**
 * Order routes — GET, POST, DELETE for /v1/orders
 */

import type { RouteContext, Env } from "../types.js";
import type { SqlClient } from "../db.js";
import { getPooledSqlClient } from "../db.js";
import { jsonResponse, jsonError } from "../response.js";
import { computeOrderHash } from "../seaportHash.js";
import { logActivity } from "../activity.js";
import { resolveCurrency, formatPriceDecimal } from "../currency.js";
import { RedisCache, CacheKeys, getCacheConfig, hashQueryParams } from "../cache.js";
import {
  recoverTypedDataAddress,
  recoverMessageAddress,
  encodeFunctionData,
  type Address,
  type Hex,
} from "viem";

// ─── Validation Helpers ─────────────────────────────────────────────────────

const ETH_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const HEX_STRING_RE = /^0x[0-9a-fA-F]+$/;
const ORDER_HASH_RE = /^0x[0-9a-fA-F]{64}$/;
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

// ─── Seaport EIP-712 Signature Verification ─────────────────────────────────

const SEAPORT_EIP712_DOMAIN = {
  name: "Seaport" as const,
  version: "1.6" as const,
  verifyingContract: "0x0000000000000068F116a894984e2DB1123eB395" as Address,
};

const SEAPORT_EIP712_TYPES = {
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
} as const;

async function recoverSeaportOrderSigner(
  chainId: number,
  order: any,
  signature: Hex,
): Promise<string> {
  const recovered = await recoverTypedDataAddress({
    domain: { ...SEAPORT_EIP712_DOMAIN, chainId },
    types: SEAPORT_EIP712_TYPES,
    primaryType: "OrderComponents",
    message: order,
    signature,
  });
  return recovered.toLowerCase();
}

async function recoverCancelSigner(
  message: string,
  signature: Hex,
): Promise<string> {
  const recovered = await recoverMessageAddress({
    message,
    signature,
  });
  return recovered.toLowerCase();
}

// ─── Seaport ABI for calldata encoding ──────────────────────────────────────

const OFFER_ITEM_TUPLE = {
  type: "tuple" as const,
  components: [
    { name: "itemType", type: "uint8" as const },
    { name: "token", type: "address" as const },
    { name: "identifierOrCriteria", type: "uint256" as const },
    { name: "startAmount", type: "uint256" as const },
    { name: "endAmount", type: "uint256" as const },
  ],
};

const CONSIDERATION_ITEM_TUPLE = {
  type: "tuple" as const,
  components: [
    { name: "itemType", type: "uint8" as const },
    { name: "token", type: "address" as const },
    { name: "identifierOrCriteria", type: "uint256" as const },
    { name: "startAmount", type: "uint256" as const },
    { name: "endAmount", type: "uint256" as const },
    { name: "recipient", type: "address" as const },
  ],
};

const ORDER_PARAMETERS_TUPLE = {
  type: "tuple" as const,
  components: [
    { name: "offer", type: "tuple[]" as const, components: OFFER_ITEM_TUPLE.components },
    { name: "consideration", type: "tuple[]" as const, components: CONSIDERATION_ITEM_TUPLE.components },
    { name: "orderType", type: "uint8" as const },
    { name: "startTime", type: "uint256" as const },
    { name: "endTime", type: "uint256" as const },
    { name: "zoneHash", type: "bytes32" as const },
    { name: "salt", type: "uint256" as const },
    { name: "conduitKey", type: "bytes32" as const },
    { name: "totalOriginalConsiderationItems", type: "uint256" as const },
  ],
};

const SEAPORT_FULFILL_ORDER_ABI = [
  {
    name: "fulfillOrder",
    type: "function" as const,
    stateMutability: "payable" as const,
    inputs: [
      {
        name: "order",
        type: "tuple" as const,
        components: [
          { name: "parameters", ...ORDER_PARAMETERS_TUPLE },
          { name: "signature", type: "bytes" as const },
        ],
      },
      { name: "fulfillerConduitKey", type: "bytes32" as const },
    ],
    outputs: [{ name: "fulfilled", type: "bool" as const }],
  },
] as const;

const CRITERIA_RESOLVER_TUPLE = {
  type: "tuple" as const,
  components: [
    { name: "orderIndex", type: "uint256" as const },
    { name: "side", type: "uint8" as const },
    { name: "index", type: "uint256" as const },
    { name: "identifier", type: "uint256" as const },
    { name: "criteriaProof", type: "bytes32[]" as const },
  ],
};

const SEAPORT_FULFILL_ADVANCED_ORDER_ABI = [
  {
    name: "fulfillAdvancedOrder",
    type: "function" as const,
    stateMutability: "payable" as const,
    inputs: [
      {
        name: "advancedOrder",
        type: "tuple" as const,
        components: [
          { name: "parameters", ...ORDER_PARAMETERS_TUPLE },
          { name: "numerator", type: "uint120" as const },
          { name: "denominator", type: "uint120" as const },
          { name: "signature", type: "bytes" as const },
          { name: "extraData", type: "bytes" as const },
        ],
      },
      { name: "criteriaResolvers", type: "tuple[]" as const, components: CRITERIA_RESOLVER_TUPLE.components },
      { name: "fulfillerConduitKey", type: "bytes32" as const },
      { name: "recipient", type: "address" as const },
    ],
    outputs: [{ name: "fulfilled", type: "bool" as const }],
  },
] as const;

const ERC20_APPROVE_ABI = [
  {
    name: "approve",
    type: "function" as const,
    stateMutability: "nonpayable" as const,
    inputs: [
      { name: "spender", type: "address" as const },
      { name: "amount", type: "uint256" as const },
    ],
    outputs: [{ name: "", type: "bool" as const }],
  },
] as const;

// ─── WebSocket Broadcast Helper ─────────────────────────────────────────────

/**
 * Broadcast an order event to WebSocket clients via the OrderStreamDO.
 * Fire-and-forget: errors are logged but never block the response.
 */
async function broadcastOrderEvent(
  env: import("../types.js").Env,
  eventType: string,
  order: { orderHash: string; chainId: number; nftContract: string; [k: string]: unknown },
): Promise<void> {
  try {
    if (!env.ORDER_STREAM || !env.INTERNAL_SECRET) return;

    const collection = (order.nftContract || "all").toLowerCase();
    const roomId = `${order.chainId}:${collection}`;
    const payload = JSON.stringify({ type: eventType, order, timestamp: Date.now() });
    const headers = {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${env.INTERNAL_SECRET}`,
    };

    // Fan out to all shards. With DO_SHARD_COUNT=1 (default) this is a single broadcast.
    const shardCount = Math.max(1, parseInt(env.DO_SHARD_COUNT || "1", 10));
    const broadcasts: Promise<unknown>[] = [];
    for (let shard = 0; shard < shardCount; shard++) {
      const shardedRoomId = shardCount === 1 ? roomId : `${roomId}:s${shard}`;
      const id = env.ORDER_STREAM.idFromName(shardedRoomId);
      const stub = env.ORDER_STREAM.get(id);
      broadcasts.push(
        stub.fetch("https://internal/internal/broadcast", { method: "POST", headers, body: payload }),
      );
    }
    await Promise.allSettled(broadcasts);
  } catch (err) {
    console.error("[oob-api] Broadcast failed (non-blocking):", err);
  }
}

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

// ─── Shared Order Parsing ───────────────────────────────────────────────────

interface ParsedOrderDetails {
  orderType: "listing" | "offer";
  nftContract: string;
  tokenId: string;
  tokenStandard: string;
  priceWei: bigint;
  currency: string;
  feeRecipient: string;
  feeBps: number;
  royaltyRecipient: string;
  royaltyBps: number;
}

/**
 * Extract NFT, price, fee, and royalty details from a Seaport order.
 * Shared between single-submit and batch-submit paths.
 * Returns null with an error string if the order cannot be parsed.
 */
function parseOrderDetails(
  order: any,
  offerer: string,
  protocolFeeRecipient: string,
): { ok: true; parsed: ParsedOrderDetails } | { ok: false; error: string } {
  const offerItems: any[] = order.offer || [];
  const considerationItems: any[] = order.consideration || [];
  const OOB_FEE = protocolFeeRecipient.toLowerCase();

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

    for (const item of considerationItems) {
      const it = Number(item.itemType);
      if (it === 0 || it === 1) {
        priceWei += safeBigInt(item.startAmount);
        if (it === 1) currency = (item.token || "").toLowerCase();
        const recipient = (item.recipient || "").toLowerCase();
        if (recipient !== offerer) {
          if (recipient === OOB_FEE) {
            feeRecipient = recipient;
          } else if (!royaltyRecipient) {
            royaltyRecipient = recipient;
          }
        }
      }
    }

    if (priceWei > 0n) {
      if (feeRecipient) {
        const feeItem = considerationItems.find(
          (i: any) => (i.recipient || "").toLowerCase() === feeRecipient && (Number(i.itemType) === 0 || Number(i.itemType) === 1),
        );
        if (feeItem) feeBps = Number((safeBigInt(feeItem.startAmount) * 10000n) / priceWei);
      }
      if (royaltyRecipient) {
        let totalRoyaltyAmount = 0n;
        for (const item of considerationItems) {
          const it = Number(item.itemType);
          if (it === 0 || it === 1) {
            const r = (item.recipient || "").toLowerCase();
            if (r !== offerer && r !== OOB_FEE) {
              totalRoyaltyAmount += safeBigInt(item.startAmount);
            }
          }
        }
        if (totalRoyaltyAmount > 0n) royaltyBps = Number((totalRoyaltyAmount * 10000n) / priceWei);
      }
    }
  } else if (nftInConsideration) {
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
        if (recipient === OOB_FEE) {
          feeRecipient = recipient;
          if (priceWei > 0n) feeBps = Number((amount * 10000n) / priceWei);
        } else {
          royaltyRecipient = recipient;
          if (priceWei > 0n) royaltyBps = Number((amount * 10000n) / priceWei);
        }
      }
    }
  } else {
    return { ok: false, error: "Order must contain an NFT in offer or consideration" };
  }

  if (!nftContract || !isValidAddress(nftContract)) {
    return { ok: false, error: "Invalid NFT contract address in order" };
  }
  if (priceWei <= 0n) {
    return { ok: false, error: "Order price must be greater than zero" };
  }

  return {
    ok: true,
    parsed: {
      orderType, nftContract, tokenId, tokenStandard,
      priceWei, currency, feeRecipient, feeBps,
      royaltyRecipient, royaltyBps,
    },
  };
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
  if (!Number.isFinite(minFeeBps) || !Number.isInteger(minFeeBps) || minFeeBps <= 0 || minFeeBps > 10000) {
    return "Protocol fee BPS misconfigured: must be an integer between 1 and 10000";
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
  const cm = resolveCurrency(row.chain_id, row.currency);
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
    currencySymbol: cm.currencySymbol,
    currencyDecimals: cm.currencyDecimals,
    priceDecimal: formatPriceDecimal(row.price_wei, cm.currencyDecimals),
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
    orderJson: (() => { try { return typeof row.order_json === "string" ? JSON.parse(row.order_json) : row.order_json; } catch { return null; } })(),
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
  // tokenIds: comma-separated list OR repeated params e.g. tokenIds=1,2,3 or tokenIds=1&tokenIds=2
  const tokenIdsRaw = params.getAll("tokenIds").flatMap((v) => v.split(",")).map((v) => v.trim()).filter(Boolean);
  const tokenIds = tokenIdsRaw.length > 0 ? [...new Set(tokenIdsRaw)] : null;
  if (tokenIds && tokenIds.length > 50) {
    return jsonError(400, "tokenIds filter supports at most 50 values");
  }
  const type = params.get("type"); // 'listing' | 'offer'
  const offerer = params.get("offerer")?.toLowerCase();
  if (offerer && !isValidAddress(offerer)) {
    return jsonError(400, "Invalid offerer address");
  }
  const status = params.get("status") || "active";
  const sortBy = params.get("sortBy") || "created_at_desc";
  const limit = Math.min(Math.max(Number(params.get("limit") || 50), 1), 100);
  const offset = Math.min(Math.max(Number(params.get("offset") || 0), 0), 10000);
  const cursor = params.get("cursor"); // base64-encoded cursor for keyset pagination

  const sql = getPooledSqlClient(ctx.env);

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
  } else if (tokenIds) {
    // ANY($N) with a text[] parameter — safe, no string interpolation of user data
    conditions.push(`token_id = ANY($${paramIdx++})`);
    queryParams.push(tokenIds);
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

  // Cursor-based pagination: decode cursor and add keyset condition
  let cursorDecoded: { created_at?: string; order_hash?: string; price_wei?: string } | null = null;
  if (cursor) {
    try {
      cursorDecoded = JSON.parse(atob(cursor));
    } catch {
      return jsonError(400, "Invalid cursor format");
    }
    // Validate cursor fields match the requested sortBy to prevent silent pagination restart
    const isPriceCursor = !!(cursorDecoded?.price_wei && cursorDecoded?.order_hash);
    const isTimeCursor = !!(cursorDecoded?.created_at && cursorDecoded?.order_hash);
    const needsPriceCursor = sortBy === "price_asc" || sortBy === "price_desc";
    if (needsPriceCursor && !isPriceCursor) {
      return jsonError(400, "Cursor is not compatible with the requested sortBy (expected price cursor)");
    }
    if (!needsPriceCursor && !isTimeCursor) {
      return jsonError(400, "Cursor is not compatible with the requested sortBy (expected created_at cursor)");
    }
  }

  let orderClause = "ORDER BY created_at DESC, order_hash DESC";
  if (sortBy === "price_asc") orderClause = "ORDER BY CAST(price_wei AS NUMERIC) ASC, order_hash ASC";
  if (sortBy === "price_desc") orderClause = "ORDER BY CAST(price_wei AS NUMERIC) DESC, order_hash DESC";

  // Apply cursor condition for keyset pagination.
  // price_desc uses two separate conditions to handle mixed-direction sort correctly:
  // (price DESC, order_hash DESC) cannot use a single row-value comparison because
  // both columns must sort in the same direction for tuple comparison to be valid.
  if (cursorDecoded) {
    if (sortBy === "price_asc" && cursorDecoded.price_wei && cursorDecoded.order_hash) {
      // Both ASC — single tuple comparison is safe
      conditions.push(`(CAST(price_wei AS NUMERIC), order_hash) > (CAST($${paramIdx++} AS NUMERIC), $${paramIdx++})`);
      queryParams.push(cursorDecoded.price_wei, cursorDecoded.order_hash);
    } else if (sortBy === "price_desc" && cursorDecoded.price_wei && cursorDecoded.order_hash) {
      // Mixed direction: price DESC, order_hash DESC — expand to avoid tuple comparison bug
      conditions.push(
        `(CAST(price_wei AS NUMERIC) < CAST($${paramIdx++} AS NUMERIC) OR (CAST(price_wei AS NUMERIC) = CAST($${paramIdx++} AS NUMERIC) AND order_hash < $${paramIdx++}))`,
      );
      queryParams.push(cursorDecoded.price_wei, cursorDecoded.price_wei, cursorDecoded.order_hash);
    } else if (cursorDecoded.created_at && cursorDecoded.order_hash) {
      conditions.push(`(created_at, order_hash) < ($${paramIdx++}::timestamptz, $${paramIdx++})`);
      queryParams.push(cursorDecoded.created_at, cursorDecoded.order_hash);
    }
  }

  const whereClause = conditions.join(" AND ");
  const useCursor = !!cursorDecoded;

  try {
    // When using cursor pagination, skip the COUNT query (not needed)
    const rowsPromise = sql(
      `SELECT * FROM seaport_orders WHERE ${whereClause} ${orderClause} LIMIT $${paramIdx++}${!useCursor ? ` OFFSET $${paramIdx++}` : ""}`,
      useCursor ? [...queryParams, limit] : [...queryParams, limit, offset],
    );

    let total: number | undefined;
    if (!useCursor) {
      // Only run COUNT for offset-based pagination (backward compat)
      const countResult = await sql(
        `SELECT COUNT(*) as total FROM seaport_orders WHERE ${whereClause}`,
        queryParams,
      );
      total = Number(countResult[0]?.total || 0);
    }

    const rows = await rowsPromise;
    const orders = rows.map(mapRowToOrder);

    // Build next cursor from the last row
    let nextCursor: string | null = null;
    if (orders.length === limit && rows.length > 0) {
      const lastRow = rows[rows.length - 1];
      const cursorObj: Record<string, string> = {
        created_at: lastRow.created_at,
        order_hash: lastRow.order_hash,
      };
      if (sortBy === "price_asc" || sortBy === "price_desc") {
        cursorObj.price_wei = lastRow.price_wei;
      }
      nextCursor = btoa(JSON.stringify(cursorObj));
    }

    return jsonResponse({
      orders,
      ...(total !== undefined ? { total } : {}),
      nextCursor,
    });
  } catch (err: any) {
    console.error("[oob-api] Failed to fetch orders:", err);
    return jsonError(500, "Failed to fetch orders");
  }
}

// ─── GET /v1/orders/:hash ───────────────────────────────────────────────────

export async function handleGetOrder(ctx: RouteContext): Promise<Response> {
  const orderHash = ctx.segments[2]; // ["v1", "orders", "<hash>"]
  if (!orderHash) return jsonError(400, "Missing order hash");
  if (!ORDER_HASH_RE.test(orderHash)) return jsonError(400, "Invalid order hash format");

  // Try cache first
  try {
    const cache = new RedisCache(ctx.env);
    const cacheKey = CacheKeys.order(orderHash);
    
    const cachedResult = await cache.getOrSet(
      cacheKey,
      async () => {
        const sql = getPooledSqlClient(ctx.env);
        const rows = await sql`
          SELECT * FROM seaport_orders WHERE order_hash = ${orderHash}
        `;
        
        if (rows.length === 0) {
          return { order: null, notFound: true };
        }
        
        return { order: mapRowToOrder(rows[0]), notFound: false };
      },
      getCacheConfig("order"),
      (data) => !data.notFound, // never cache not-found — order may be submitted moments later
    );

    if (cachedResult.notFound) {
      return jsonError(404, "Order not found");
    }
    
    return jsonResponse({ order: cachedResult.order });
  } catch (cacheErr) {
    console.warn("[oob-api] Cache unavailable for order lookup, falling back to DB:", cacheErr);
    
    // Fallback to direct DB query
    const sql = getPooledSqlClient(ctx.env);

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
}

// ─── GET /v1/orders/best-listing ────────────────────────────────────────────

export async function handleBestListing(ctx: RouteContext): Promise<Response> {
  const { params } = ctx;
  const chainIdRaw = params.get("chainId");
  const collection = params.get("collection")?.toLowerCase();
  const tokenId = params.get("tokenId");

  if (!chainIdRaw || !collection) {
    return jsonError(400, "Missing chainId or collection");
  }
  if (!isValidChainId(chainIdRaw)) {
    return jsonError(400, "Invalid chainId parameter");
  }
  const chainId = Number(chainIdRaw);

  // Validate tokenId format — must be a decimal uint256 (1–78 digits)
  if (tokenId && !/^\d{1,78}$/.test(tokenId)) {
    return jsonError(400, "Invalid tokenId format");
  }

  // Try cache first
  try {
    const cache = new RedisCache(ctx.env);
    const cacheKey = tokenId 
      ? `${CacheKeys.bestListing(String(chainId), collection)}:${tokenId}`
      : CacheKeys.bestListing(String(chainId), collection);
    
    const cachedResult = await cache.getOrSet(
      cacheKey,
      async () => {
        const sql = getPooledSqlClient(ctx.env);
        const now = Math.floor(Date.now() / 1000);
        
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
        
        return { order: rows.length > 0 ? mapRowToOrder(rows[0]) : null };
      },
      getCacheConfig("bestListing")
    );

    return jsonResponse(cachedResult);
  } catch (cacheErr) {
    console.warn("[oob-api] Cache unavailable for best listing, falling back to DB:", cacheErr);
    
    // Fallback to direct DB query
    const sql = getPooledSqlClient(ctx.env);
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
}

// ─── GET /v1/orders/best-offer ──────────────────────────────────────────────

export async function handleBestOffer(ctx: RouteContext): Promise<Response> {
  const { params } = ctx;
  const chainIdRaw = params.get("chainId");
  const collection = params.get("collection")?.toLowerCase();
  const tokenId = params.get("tokenId");

  if (!chainIdRaw || !collection) {
    return jsonError(400, "Missing chainId or collection");
  }
  if (!isValidChainId(chainIdRaw)) {
    return jsonError(400, "Invalid chainId parameter");
  }
  if (!isValidAddress(collection)) {
    return jsonError(400, "Invalid collection address");
  }
  if (tokenId && !/^\d{1,78}$/.test(tokenId)) {
    return jsonError(400, "Invalid tokenId format");
  }
  const chainId = Number(chainIdRaw);

  const sql = getPooledSqlClient(ctx.env);
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
    const recovered = await recoverSeaportOrderSigner(Number(chainId), order, signature as Hex);
    if (recovered !== offerer) {
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

  // Determine order type and extract NFT + price details (shared helper)
  const OOB_FEE_RECIPIENT = (ctx.env.PROTOCOL_FEE_RECIPIENT || "0x0000000000000000000000000000000000000001");
  const parseResult = parseOrderDetails(order, offerer, OOB_FEE_RECIPIENT);
  if (!parseResult.ok) {
    return jsonError(400, parseResult.error);
  }
  const { orderType, nftContract, tokenId, tokenStandard, priceWei, currency, feeRecipient, feeBps, royaltyRecipient, royaltyBps } = parseResult.parsed;

  // Compute the real Seaport EIP-712 order hash (matches on-chain events)
  const orderHash = computeOrderHash(order, Number(chainId));

  const sql = getPooledSqlClient(ctx.env);

  try {
    // Redis-based deduplication check (faster than DB)
    const dedupResult = await new RedisCache(ctx.env).deduplicate(orderHash, 300).catch(() => "error" as const);

    if (dedupResult === "duplicate") {
      return jsonResponse({ orderHash, status: "active", duplicate: true });
    }

    if (dedupResult === "error") {
      // Redis unavailable — fall back to DB check so valid orders are never wrongly rejected
      console.warn("[oob-api] Redis deduplication unavailable, falling back to DB check");
      const existing = await sql`
        SELECT order_hash FROM seaport_orders WHERE order_hash = ${orderHash}
      `;
      if (existing.length > 0) {
        return jsonResponse({ orderHash, status: "active", duplicate: true });
      }
    }
    // dedupResult === "new" → proceed normally

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

    // Write path: enqueue (async, 202) if queue is configured, else direct DB write (sync, 201)
    if (ctx.env.ORDER_INGEST_QUEUE) {
      await ctx.env.ORDER_INGEST_QUEUE.send({
        chainId: Number(chainId),
        order,
        signature,
        orderHash,
        orderType,
        nftContract,
        tokenId,
        tokenStandard,
        priceWei: priceWei.toString(),
        currency,
        offerer,
        zone,
        startTime,
        endTime,
        feeRecipient,
        feeBps,
        royaltyRecipient: royaltyRecipient || null,
        royaltyBps,
      });

      // Broadcast to WebSocket clients (fire-and-forget)
      broadcastOrderEvent(ctx.env, orderType === "listing" ? "new_listing" : "new_offer", {
        orderHash, chainId: Number(chainId), nftContract, tokenId, offerer,
        priceWei: priceWei.toString(), currency, orderType,
      });

      return jsonResponse({ orderHash, status: "queued" }, 202);
    }

    // Synchronous path (no queue configured): direct DB write with per-offerer cap enforcement
    const insertResult = await sql`
      INSERT INTO seaport_orders (
        order_hash, chain_id, order_type, offerer, zone,
        nft_contract, token_id, token_standard,
        price_wei, currency,
        fee_recipient, fee_bps,
        royalty_recipient, royalty_bps,
        order_json, signature,
        start_time, end_time,
        status
      )
      SELECT
        ${orderHash}, ${Number(chainId)}, ${orderType}, ${offerer}, ${zone},
        ${nftContract}, ${tokenId}, ${tokenStandard},
        ${priceWei.toString()}, ${currency},
        ${feeRecipient}, ${feeBps},
        ${royaltyRecipient || null}, ${royaltyBps},
        ${JSON.stringify(order)}, ${signature},
        ${startTime}, ${endTime},
        'active'
      WHERE (
        SELECT COUNT(*)::int FROM seaport_orders
        WHERE offerer = ${offerer} AND status = 'active'
      ) < ${MAX_ACTIVE_ORDERS_PER_OFFERER}
      RETURNING order_hash
    `;
    if (!insertResult || insertResult.length === 0) {
      return jsonError(429, `Too many active orders for this offerer (max ${MAX_ACTIVE_ORDERS_PER_OFFERER})`);
    }

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

    // Invalidate related cache entries
    try {
      const cache = new RedisCache(ctx.env);
      const chainIdStr = String(chainId);
      await Promise.all([
        cache.del(CacheKeys.allBestListings(chainIdStr, nftContract)),
        cache.del(CacheKeys.allCollectionStats(chainIdStr, nftContract)),
        cache.del(CacheKeys.allOrdersLists(chainIdStr, nftContract)),
      ]);
    } catch (cacheErr) {
      console.warn("[oob-api] Cache invalidation failed for order submission:", cacheErr);
    }

    // Broadcast to WebSocket clients (fire-and-forget)
    broadcastOrderEvent(ctx.env, orderType === "listing" ? "new_listing" : "new_offer", {
      orderHash, chainId: Number(chainId), nftContract, tokenId, offerer,
      priceWei: priceWei.toString(), currency, orderType,
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
  if (!ORDER_HASH_RE.test(orderHash)) return jsonError(400, "Invalid order hash format");

  let body: any = {};
  try {
    const raw = await readBodyWithLimit(ctx.request, 16 * 1024); // 16KB max for cancel
    body = JSON.parse(raw);
  } catch (err: any) {
    if (err.message === "BODY_TOO_LARGE") return jsonError(413, "Request body too large");
    // body parse failure is OK — signature may be missing, handled below
  }

  const sql = getPooledSqlClient(ctx.env);

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
    const message = `cancel:${orderHash}`;
    const recovered = await recoverCancelSigner(message, cancelSig as Hex);
    if (recovered !== orderRows[0].offerer.toLowerCase()) {
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

    // Invalidate related cache entries
    try {
      const cache = new RedisCache(ctx.env);
      const chainId = String(orderRows[0].chain_id || 0);
      const collection = orderRows[0].nft_contract;
      
      // Invalidate order-specific cache
      await cache.del(CacheKeys.order(orderHash));
      
      // Invalidate collection-related caches
      await Promise.all([
        cache.del(CacheKeys.allBestListings(chainId, collection)),
        cache.del(CacheKeys.allCollectionStats(chainId, collection)),
        cache.del(CacheKeys.allOrdersLists(chainId, collection)),
      ]);
    } catch (cacheErr) {
      console.warn("[oob-api] Cache invalidation failed for order cancellation:", cacheErr);
    }

    // Broadcast to WebSocket clients (fire-and-forget)
    broadcastOrderEvent(ctx.env, "cancellation", {
      orderHash, chainId: orderRows[0].chain_id || 0,
      nftContract: orderRows[0].nft_contract, tokenId: orderRows[0].token_id,
      offerer: orderRows[0].offerer,
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
  const chainIdRaw = params.get("chainId");
  const collection = ctx.segments[2]?.toLowerCase(); // ["v1", "collections", "<address>", "stats"]

  if (!chainIdRaw || !collection) {
    return jsonError(400, "Missing chainId or collection address");
  }
  if (!isValidChainId(chainIdRaw)) {
    return jsonError(400, "Invalid chainId parameter");
  }
  if (!isValidAddress(collection)) {
    return jsonError(400, "Invalid collection address");
  }
  const chainId = Number(chainIdRaw);

  // Try cache first
  try {
    const cache = new RedisCache(ctx.env);
    const cacheKey = CacheKeys.collectionStats(String(chainId), collection);
    
    const cachedResult = await cache.getOrSet(
      cacheKey,
      async () => {
        const sql = getPooledSqlClient(ctx.env);
        const now = Math.floor(Date.now() / 1000);
        
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

        return {
          collection,
          chainId: Number(chainId),
          listingCount: Number(listingStats[0]?.listing_count || 0),
          floorPriceWei: listingStats[0]?.floor_price_wei?.toString() || null,
          offerCount: Number(offerStats[0]?.offer_count || 0),
          bestOfferWei: offerStats[0]?.best_offer_wei?.toString() || null,
        };
      },
      getCacheConfig("collectionStats")
    );

    return jsonResponse(cachedResult);
  } catch (cacheErr) {
    console.warn("[oob-api] Cache unavailable for collection stats, falling back to DB:", cacheErr);
    
    // Fallback to direct DB query
    const sql = getPooledSqlClient(ctx.env);
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
}

// ─── GET /v1/activity ─────────────────────────────────────────────────────

export async function handleGetActivity(ctx: RouteContext): Promise<Response> {
  const { params } = ctx;
  const chainIdRaw = params.get("chainId");
  const orderHash = params.get("orderHash");

  // chainId is optional when querying by orderHash (orderHash is globally unique)
  let chainId: number | null = null;
  if (chainIdRaw) {
    if (!isValidChainId(chainIdRaw)) {
      return jsonError(400, "Invalid chainId parameter");
    }
    chainId = Number(chainIdRaw);
  } else if (!orderHash) {
    return jsonError(400, "Missing chainId parameter (required unless orderHash is provided)");
  }

  const collection = params.get("collection")?.toLowerCase();
  const tokenId = params.get("tokenId");
  const eventType = params.get("eventType");
  const addressRaw = params.get("address")?.toLowerCase();
  if (addressRaw && !isValidAddress(addressRaw)) {
    return jsonError(400, "Invalid address parameter");
  }
  const address = addressRaw; // from or to
  const limit = Math.min(Math.max(Number(params.get("limit") || 50), 1), 200);
  const offset = Math.min(Math.max(Number(params.get("offset") || 0), 0), 10000);

  const sql = getPooledSqlClient(ctx.env);

  const conditions: string[] = [];
  const queryParams: any[] = [];
  let paramIdx = 1;

  if (chainId !== null) {
    conditions.push(`chain_id = $${paramIdx++}`);
    queryParams.push(chainId);
  }

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

  const whereClause = conditions.length > 0 ? conditions.join(" AND ") : "TRUE";

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
    const activity = rows.map((r: any) => {
      const cm = resolveCurrency(r.chain_id, r.currency);
      return {
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
        currencySymbol: cm.currencySymbol,
        currencyDecimals: cm.currencyDecimals,
        priceDecimal: formatPriceDecimal(r.price_wei, cm.currencyDecimals),
        txHash: r.tx_hash,
        createdAt: r.created_at,
      };
    });

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

  const sql = getPooledSqlClient(ctx.env);
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
  env: Env,
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
    const recovered = await recoverSeaportOrderSigner(Number(chainId), order, signature as Hex);
    if (recovered !== offerer) {
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

  // Extract NFT + price details (shared helper)
  const OOB_FEE_RECIPIENT = (env.PROTOCOL_FEE_RECIPIENT || "0x0000000000000000000000000000000000000001");
  const parseResult = parseOrderDetails(order, offerer, OOB_FEE_RECIPIENT);
  if (!parseResult.ok) {
    return { orderHash: "", status: "error", error: parseResult.error };
  }
  const { orderType, nftContract, tokenId, tokenStandard, priceWei, currency, feeRecipient, feeBps, royaltyRecipient, royaltyBps } = parseResult.parsed;

  const orderHash = computeOrderHash(order, Number(chainId));

  // Redis-based deduplication (faster than DB); fall back to DB on Redis error
  const dedupResult = await new RedisCache(env).deduplicate(orderHash, 300).catch(() => "error" as const);
  if (dedupResult === "duplicate") {
    return { orderHash, status: "active", duplicate: true };
  }
  if (dedupResult === "error") {
    const existing = await sql`SELECT order_hash FROM seaport_orders WHERE order_hash = ${orderHash}`;
    if (existing.length > 0) {
      return { orderHash, status: "active", duplicate: true };
    }
  }

  // Duplicate listing check (before the atomic insert below)
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

  // Atomically enforce the per-offerer cap: INSERT ... SELECT so the count check
  // and the insert happen in a single statement — no race condition possible.
  const insertResult = await sql`
    INSERT INTO seaport_orders (
      order_hash, chain_id, order_type, offerer, zone,
      nft_contract, token_id, token_standard,
      price_wei, currency,
      fee_recipient, fee_bps,
      royalty_recipient, royalty_bps,
      order_json, signature,
      start_time, end_time, status
    )
    SELECT
      ${orderHash}, ${Number(chainId)}, ${orderType}, ${offerer}, ${zone},
      ${nftContract}, ${tokenId}, ${tokenStandard},
      ${priceWei.toString()}, ${currency},
      ${feeRecipient}, ${feeBps},
      ${royaltyRecipient || null}, ${royaltyBps},
      ${JSON.stringify(order)}, ${signature},
      ${startTime}, ${endTime}, 'active'
    WHERE (
      SELECT COUNT(*)::int FROM seaport_orders
      WHERE offerer = ${offerer} AND status = 'active'
    ) < ${MAX_ACTIVE_ORDERS_PER_OFFERER}
    RETURNING order_hash
  `;
  if (!insertResult || insertResult.length === 0) {
    return { orderHash, status: "error", error: `Too many active orders for this offerer (max ${MAX_ACTIVE_ORDERS_PER_OFFERER})` };
  }

  await logActivity(sql, {
    orderHash,
    chainId: Number(chainId),
    eventType: orderType === "listing" ? "listed" : "offer_placed",
    fromAddress: offerer,
    nftContract, tokenId,
    priceWei: priceWei.toString(),
    currency,
  });

  // Invalidate related cache entries (same as single-order path)
  try {
    const cache = new RedisCache(env);
    const chainIdStr = String(chainId);
    await Promise.all([
      cache.del(CacheKeys.allBestListings(chainIdStr, nftContract)),
      cache.del(CacheKeys.allCollectionStats(chainIdStr, nftContract)),
      cache.del(CacheKeys.allOrdersLists(chainIdStr, nftContract)),
    ]);
  } catch {
    // Non-fatal — cache will expire naturally
  }

  return { orderHash, status: "active" };
}

// ─── On-chain ownerOf validation ────────────────────────────────────────────

const CHAIN_RPC_MAP: Record<number, keyof Env> = {
  1: "RPC_URL_ETHEREUM",
  8453: "RPC_URL_BASE",
  84532: "RPC_URL_BASE_SEPOLIA",
  999: "RPC_URL_HYPERLIQUID",
  2020: "RPC_URL_RONIN",
  202601: "RPC_URL_RONIN_TESTNET",
  2741: "RPC_URL_ABSTRACT",
};

const OWNER_OF_SELECTOR = "0x6352211e";

function encodeUint256Hex(value: string): string {
  return BigInt(value).toString(16).padStart(64, "0");
}

/**
 * Check on-chain whether the offerer still owns the NFT.
 * Returns null if the RPC is unavailable or the call fails (fail-open).
 * Returns true if offerer owns the token, false if not.
 */
async function checkOwnerOf(
  env: Env,
  chainId: number,
  nftContract: string,
  tokenId: string,
  offerer: string,
): Promise<boolean | null> {
  const rpcKey = CHAIN_RPC_MAP[chainId];
  const rpcUrl = rpcKey ? (env[rpcKey] as string | undefined) : undefined;
  if (!rpcUrl) return null; // No RPC configured for this chain — skip

  try {
    const callData = OWNER_OF_SELECTOR + encodeUint256Hex(tokenId);
    const resp = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_call",
        params: [{ to: nftContract, data: callData }, "latest"],
      }),
    });
    const json = await resp.json() as any;
    if (json.error || !json.result || json.result.length < 42) return null;
    const owner = "0x" + json.result.slice(-40).toLowerCase();
    return owner === offerer.toLowerCase();
  } catch {
    return null; // RPC failure — fail open
  }
}

// ─── GET /v1/orders/:hash/fill-tx ───────────────────────────────────────────

const SEAPORT_ADDRESS = "0x0000000000000068F116a894984e2DB1123eB395";

/**
 * Encode calldata for Seaport fulfillOrder (no tip).
 */
function encodeFulfillOrder(orderJson: any, signature: string): string {
  const params = buildOrderParameters(orderJson);

  return encodeFunctionData({
    abi: SEAPORT_FULFILL_ORDER_ABI,
    functionName: "fulfillOrder",
    args: [
      {
        parameters: params,
        signature: signature as Hex,
      },
      "0x0000000000000000000000000000000000000000000000000000000000000000" as Hex,
    ],
  });
}

/**
 * Encode calldata for Seaport fulfillAdvancedOrder (with tip).
 */
function encodeFulfillAdvancedOrder(
  orderJson: any,
  signature: string,
  tipItemType: number,
  tipToken: string,
  tipAmount: bigint,
  tipRecipient: string,
): string {
  const params = buildOrderParameters(orderJson);

  const considerationWithTip = [
    ...params.consideration,
    {
      itemType: tipItemType,
      token: tipToken as Address,
      identifierOrCriteria: 0n,
      startAmount: tipAmount,
      endAmount: tipAmount,
      recipient: tipRecipient as Address,
    },
  ];

  return encodeFunctionData({
    abi: SEAPORT_FULFILL_ADVANCED_ORDER_ABI,
    functionName: "fulfillAdvancedOrder",
    args: [
      {
        parameters: { ...params, consideration: considerationWithTip },
        numerator: 1n,
        denominator: 1n,
        signature: signature as Hex,
        extraData: "0x" as Hex,
      },
      [], // criteriaResolvers
      "0x0000000000000000000000000000000000000000000000000000000000000000" as Hex, // fulfillerConduitKey
      "0x0000000000000000000000000000000000000000" as Address, // recipient (0 = msg.sender)
    ],
  });
}

/**
 * Convert stored orderJson (string amounts) into the struct viem expects (bigints).
 */
function buildOrderParameters(orderJson: any) {
  return {
    offerer: orderJson.offerer,
    zone: orderJson.zone,
    offer: (orderJson.offer || []).map((item: any) => ({
      itemType: Number(item.itemType),
      token: item.token,
      identifierOrCriteria: BigInt(item.identifierOrCriteria),
      startAmount: BigInt(item.startAmount),
      endAmount: BigInt(item.endAmount),
    })),
    consideration: (orderJson.consideration || []).map((item: any) => ({
      itemType: Number(item.itemType),
      token: item.token,
      identifierOrCriteria: BigInt(item.identifierOrCriteria),
      startAmount: BigInt(item.startAmount),
      endAmount: BigInt(item.endAmount),
      recipient: item.recipient,
    })),
    orderType: Number(orderJson.orderType),
    startTime: BigInt(orderJson.startTime),
    endTime: BigInt(orderJson.endTime),
    zoneHash: orderJson.zoneHash,
    salt: BigInt(orderJson.salt),
    conduitKey: orderJson.conduitKey,
    totalOriginalConsiderationItems: BigInt((orderJson.consideration || []).length),
  };
}

/**
 * GET /v1/orders/:hash/fill-tx
 *
 * Returns a ready-to-sign transaction object for filling a Seaport listing.
 * The caller just needs to sign and broadcast — no Seaport knowledge required.
 *
 * Query params:
 *   - buyer (required): address of the wallet that will send the transaction
 *   - tipRecipient (optional): address to receive a marketplace tip
 *   - tipBps (optional): tip in basis points (e.g. 100 = 1%)
 *
 * Response:
 *   {
 *     to: string,           // Seaport contract address
 *     data: string,         // ABI-encoded calldata (hex)
 *     value: string,        // ETH value in wei (as decimal string) — "0" for ERC20 orders
 *     chainId: number,
 *     orderHash: string,
 *     orderType: "listing" | "offer",
 *     currency: string,     // payment token address (0x0...0 = native ETH)
 *     priceWei: string,
 *   }
 *
 * Only listings are supported for fill-tx (offers require the seller to initiate).
 */
export async function handleFillTx(ctx: RouteContext): Promise<Response> {
  const orderHash = ctx.segments[2];
  if (!orderHash) return jsonError(400, "Missing order hash");
  if (!ORDER_HASH_RE.test(orderHash)) return jsonError(400, "Invalid order hash format");

  // buyer param — required so agents know which address to send from
  const buyer = ctx.params.get("buyer")?.toLowerCase();
  if (!buyer) return jsonError(400, "Missing required query param: buyer");
  if (!isValidAddress(buyer)) return jsonError(400, "Invalid buyer address");

  // Optional on-chain ownership validation before returning calldata
  const validateOnChain = ctx.params.get("validate") === "true";

  // Optional tip
  const tipRecipientRaw = ctx.params.get("tipRecipient");
  const tipBpsRaw = ctx.params.get("tipBps");
  if ((tipRecipientRaw && !tipBpsRaw) || (!tipRecipientRaw && tipBpsRaw)) {
    return jsonError(400, "tipRecipient and tipBps must be provided together");
  }
  const hasTip = !!(tipRecipientRaw && tipBpsRaw);

  if (tipRecipientRaw && !isValidAddress(tipRecipientRaw)) {
    return jsonError(400, "Invalid tipRecipient address");
  }
  const tipBps = hasTip ? Number(tipBpsRaw) : 0;
  if (hasTip && (!Number.isFinite(tipBps) || tipBps <= 0 || tipBps > 10000)) {
    return jsonError(400, "tipBps must be between 1 and 10000");
  }

  const sql = getPooledSqlClient(ctx.env);

  let row: any;
  try {
    const rows = await sql`
      SELECT * FROM seaport_orders WHERE order_hash = ${orderHash}
    `;
    if (rows.length === 0) return jsonError(404, "Order not found");
    row = rows[0];
  } catch (err: any) {
    console.error("[oob-api] fill-tx: DB error:", err);
    return jsonError(500, "Failed to fetch order");
  }

  // Only active listings can be filled via this endpoint
  if (row.order_type !== "listing") {
    return jsonError(400, {
      code: "UNSUPPORTED_ORDER_TYPE",
      message: "fill-tx only supports listings. Offers must be filled by the NFT owner on-chain.",
      orderType: row.order_type,
    });
  }
  if (row.status !== "active") {
    return jsonError(409, {
      code: "ORDER_NOT_ACTIVE",
      message: `Order cannot be filled because it is ${row.status}.`,
      status: row.status,
      orderHash: row.order_hash,
      ...(row.status === "filled" ? { filledTxHash: row.filled_tx_hash, filledAt: row.filled_at } : {}),
      ...(row.status === "cancelled" ? { cancelledTxHash: row.cancelled_tx_hash, cancelledAt: row.cancelled_at } : {}),
    });
  }
  const now = Math.floor(Date.now() / 1000);
  if (Number(row.end_time) <= now) {
    return jsonError(409, {
      code: "ORDER_EXPIRED",
      message: "Order has expired and can no longer be filled.",
      orderHash: row.order_hash,
      expiredAt: Number(row.end_time),
      expiredAgo: `${Math.floor((now - Number(row.end_time)) / 60)} minutes ago`,
    });
  }

  // Prevent buyer from filling their own listing
  if (row.offerer?.toLowerCase() === buyer) {
    return jsonError(400, {
      code: "SELF_FILL",
      message: "Buyer address matches the order offerer. You cannot fill your own listing.",
      offerer: row.offerer,
      buyer,
    });
  }

  // Optimistic locking: warn if another agent is already filling this order
  let fillPendingWarning: string | undefined;
  try {
    const cache = new RedisCache(ctx.env);
    const alreadyPending = await cache.isPending(orderHash);
    if (alreadyPending) {
      fillPendingWarning = "Another buyer is currently processing this order. High risk of transaction failure.";
    } else {
      await cache.setPending(orderHash, 30); // 30s TTL — enough for a tx to land
    }
  } catch {
    // Redis unavailable — fail open, proceed without locking
  }

  // Optional on-chain ownerOf check — only for ERC721 listings, only when ?validate=true
  if (validateOnChain && row.token_standard === "ERC721") {
    const ownerOf = await checkOwnerOf(
      ctx.env,
      Number(row.chain_id),
      row.nft_contract,
      row.token_id,
      row.offerer,
    );
    if (ownerOf === false) {
      return jsonError(409, {
        code: "SELLER_NO_LONGER_OWNS",
        message: "The seller no longer owns this NFT. This order will revert if filled.",
        orderHash: row.order_hash,
        offerer: row.offerer,
        nftContract: row.nft_contract,
        tokenId: row.token_id,
      });
    }
    // ownerOf === null means RPC unavailable — fail open, proceed with calldata
  }

  let orderJson: any;
  try {
    orderJson = typeof row.order_json === "string" ? JSON.parse(row.order_json) : row.order_json;
  } catch {
    console.error("[oob-api] fill-tx: malformed order_json for", row.order_hash);
    return jsonError(500, { code: "MALFORMED_ORDER", message: "Stored order data is malformed.", orderHash: row.order_hash });
  }
  const signature = row.signature as string;

  // Calculate ETH value the buyer must send (sum of all NATIVE consideration items)
  let valueWei = 0n;
  const isNativePayment = row.currency === "0x0000000000000000000000000000000000000000";
  if (isNativePayment) {
    for (const item of (orderJson.consideration || [])) {
      if (Number(item.itemType) === 0) { // NATIVE
        valueWei += BigInt(item.startAmount);
      }
    }
  }

  let calldata: string;
  try {
    if (hasTip) {
      const tipAmount = (BigInt(row.price_wei) * BigInt(tipBps)) / 10000n;
      if (tipAmount <= 0n) return jsonError(400, "Tip amount rounds to zero — increase tipBps or use a higher-priced order");

      const tipItemType = isNativePayment ? 0 : 1; // NATIVE or ERC20
      const tipToken = isNativePayment
        ? "0x0000000000000000000000000000000000000000"
        : row.currency;

      if (isNativePayment) valueWei += tipAmount;

      calldata = encodeFulfillAdvancedOrder(
        orderJson,
        signature,
        tipItemType,
        tipToken,
        tipAmount,
        tipRecipientRaw!,
      );
    } else {
      calldata = encodeFulfillOrder(orderJson, signature);
    }
  } catch (err: any) {
    console.error("[oob-api] fill-tx: ABI encoding error:", err);
    return jsonError(500, {
      code: "CALLDATA_ENCODING_FAILED",
      message: "Failed to encode Seaport transaction calldata. The stored order data may be malformed.",
      orderHash: row.order_hash,
    });
  }

  const cm = resolveCurrency(row.chain_id, row.currency);

  return jsonResponse({
    to: SEAPORT_ADDRESS,
    data: calldata,
    value: valueWei.toString(),
    chainId: row.chain_id,
    orderHash: row.order_hash,
    orderType: row.order_type,
    nftContract: row.nft_contract,
    tokenId: row.token_id,
    tokenStandard: row.token_standard,
    offerer: row.offerer,
    currency: row.currency,
    currencySymbol: cm.currencySymbol,
    currencyDecimals: cm.currencyDecimals,
    priceWei: row.price_wei,
    priceDecimal: formatPriceDecimal(row.price_wei, cm.currencyDecimals),
    expiresAt: Number(row.end_time),
    ...(hasTip ? { tipBps, tipRecipient: tipRecipientRaw } : {}),
    ...(fillPendingWarning ? { warning: fillPendingWarning } : {}),
  });
}

// ─── POST /v1/orders/batch/fill-tx ──────────────────────────────────────────
//
// Sweep endpoint: given an array of order hashes, returns an array of
// ready-to-sign transactions (one per order). The agent broadcasts them
// sequentially or in parallel depending on their wallet setup.
//
// Why not a single fulfillAvailableOrders call?
//   fulfillAvailableOrders requires fulfillment component arrays that map
//   offer/consideration items across orders — complex to compute server-side
//   for heterogeneous orders (different collections, currencies, royalties).
//   Returning individual transactions is simpler, more predictable, and lets
//   the agent decide execution order and handle partial failures gracefully.
//
// Request body:
//   { buyer: string, orderHashes: string[], tipRecipient?: string, tipBps?: number }
//
// Response:
//   { transactions: FillTxResult[], totalValueWei: string, currency: string | null }
//   Each FillTxResult: { orderHash, to, data, value, chainId, nftContract, tokenId,
//                        priceWei, currency, expiresAt, error? }
//   Orders that cannot be filled (expired, filled, wrong type) are returned with
//   an `error` field instead of calldata so the agent can skip them cleanly.

const MAX_BATCH_FILL_SIZE = 20;

export async function handleBatchFillTx(ctx: RouteContext): Promise<Response> {
  let body: any;
  try {
    const raw = await readBodyWithLimit(ctx.request, MAX_BODY_SIZE * MAX_BATCH_FILL_SIZE);
    body = JSON.parse(raw);
  } catch (err: any) {
    if (err.message === "BODY_TOO_LARGE") return jsonError(413, "Request body too large");
    return jsonError(400, "Invalid JSON body");
  }

  const { buyer, orderHashes, tipRecipient: tipRecipientRaw, tipBps: tipBpsRaw } = body;

  if (!buyer || typeof buyer !== "string") return jsonError(400, "Missing required field: buyer");
  if (!isValidAddress(buyer)) return jsonError(400, "Invalid buyer address");
  if (!Array.isArray(orderHashes) || orderHashes.length === 0) {
    return jsonError(400, "Missing or empty 'orderHashes' array");
  }
  if (orderHashes.length > MAX_BATCH_FILL_SIZE) {
    return jsonError(400, `Batch size exceeds maximum (${MAX_BATCH_FILL_SIZE})`);
  }
  for (const h of orderHashes) {
    if (typeof h !== "string" || !ORDER_HASH_RE.test(h)) {
      return jsonError(400, "Invalid order hash in array: each hash must be a 0x-prefixed 32-byte hex string");
    }
  }

  if ((tipRecipientRaw && tipBpsRaw == null) || (!tipRecipientRaw && tipBpsRaw != null)) {
    return jsonError(400, "tipRecipient and tipBps must be provided together");
  }
  const hasTip = !!(tipRecipientRaw && tipBpsRaw != null);
  if (hasTip) {
    if (!isValidAddress(tipRecipientRaw)) return jsonError(400, "Invalid tipRecipient address");
    const tipBpsNum = Number(tipBpsRaw);
    if (!Number.isFinite(tipBpsNum) || tipBpsNum <= 0 || tipBpsNum > 10000) {
      return jsonError(400, "tipBps must be between 1 and 10000");
    }
  }
  const tipBps = hasTip ? Number(tipBpsRaw) : 0;

  const sql = getPooledSqlClient(ctx.env);
  const now = Math.floor(Date.now() / 1000);
  const buyerLower = buyer.toLowerCase();

  // Fetch all requested orders in one query
  let rows: any[];
  try {
    rows = await sql(
      `SELECT * FROM seaport_orders WHERE order_hash = ANY($1)`,
      [orderHashes],
    );
  } catch (err: any) {
    console.error("[oob-api] batch fill-tx: DB error:", err);
    return jsonError(500, "Failed to fetch orders");
  }

  // Index rows by hash for O(1) lookup, preserving request order
  const rowByHash = new Map<string, any>();
  for (const row of rows) rowByHash.set(row.order_hash, row);

  const transactions: any[] = [];
  let totalValueWei = 0n;
  let commonCurrency: string | null = null;
  let mixedCurrencies = false;

  for (const orderHash of orderHashes) {
    const row = rowByHash.get(orderHash);

    // Not found
    if (!row) {
      transactions.push({
        orderHash,
        error: { code: "NOT_FOUND", message: "Order not found in the order book" },
      });
      continue;
    }

    // Offers not supported
    if (row.order_type !== "listing") {
      transactions.push({
        orderHash,
        error: {
          code: "UNSUPPORTED_ORDER_TYPE",
          message: "fill-tx only supports listings. Offers must be filled by the NFT owner on-chain.",
          orderType: row.order_type,
        },
      });
      continue;
    }

    // Not active
    if (row.status !== "active") {
      transactions.push({
        orderHash,
        error: {
          code: "ORDER_NOT_ACTIVE",
          message: `Order cannot be filled because it is ${row.status}.`,
          status: row.status,
          ...(row.status === "filled" ? { filledTxHash: row.filled_tx_hash, filledAt: row.filled_at } : {}),
          ...(row.status === "cancelled" ? { cancelledTxHash: row.cancelled_tx_hash, cancelledAt: row.cancelled_at } : {}),
        },
      });
      continue;
    }

    // Expired
    if (Number(row.end_time) <= now) {
      transactions.push({
        orderHash,
        error: {
          code: "ORDER_EXPIRED",
          message: "Order has expired and can no longer be filled.",
          expiredAt: Number(row.end_time),
          expiredAgo: `${Math.floor((now - Number(row.end_time)) / 60)} minutes ago`,
        },
      });
      continue;
    }

    // Self-fill
    if (row.offerer?.toLowerCase() === buyerLower) {
      transactions.push({
        orderHash,
        error: {
          code: "SELF_FILL",
          message: "Buyer address matches the order offerer. You cannot fill your own listing.",
          offerer: row.offerer,
        },
      });
      continue;
    }

    let orderJson: any;
    try {
      orderJson = typeof row.order_json === "string" ? JSON.parse(row.order_json) : row.order_json;
    } catch {
      console.error("[oob-api] batch fill-tx: malformed order_json for", orderHash);
      transactions.push({ orderHash, error: { code: "MALFORMED_ORDER", message: "Stored order data is malformed." } });
      continue;
    }
    const signature = row.signature as string;

    const isNativePayment = row.currency === "0x0000000000000000000000000000000000000000";
    let valueWei = 0n;
    if (isNativePayment) {
      for (const item of (orderJson.consideration || [])) {
        if (Number(item.itemType) === 0) valueWei += BigInt(item.startAmount);
      }
    }

    // Track currency consistency for the summary field
    if (commonCurrency === null) {
      commonCurrency = row.currency;
    } else if (commonCurrency !== row.currency) {
      mixedCurrencies = true;
    }

    let calldata: string;
    try {
      if (hasTip) {
        const tipAmount = (BigInt(row.price_wei) * BigInt(tipBps)) / 10000n;
        if (tipAmount <= 0n) {
          transactions.push({
            orderHash,
            error: {
              code: "TIP_TOO_SMALL",
              message: "Tip amount rounds to zero for this order price. Increase tipBps.",
              priceWei: row.price_wei,
              tipBps,
            },
          });
          continue;
        }
        const tipItemType = isNativePayment ? 0 : 1;
        const tipToken = isNativePayment ? "0x0000000000000000000000000000000000000000" : row.currency;
        if (isNativePayment) valueWei += tipAmount;
        calldata = encodeFulfillAdvancedOrder(orderJson, signature, tipItemType, tipToken, tipAmount, tipRecipientRaw);
      } else {
        calldata = encodeFulfillOrder(orderJson, signature);
      }
    } catch (err: any) {
      console.error("[oob-api] batch fill-tx: encoding error for", orderHash, err);
      transactions.push({
        orderHash,
        error: {
          code: "CALLDATA_ENCODING_FAILED",
          message: "Failed to encode Seaport transaction calldata. The stored order data may be malformed.",
        },
      });
      continue;
    }

    totalValueWei += valueWei;
    const cm = resolveCurrency(row.chain_id, row.currency);

    transactions.push({
      orderHash: row.order_hash,
      to: SEAPORT_ADDRESS,
      data: calldata,
      value: valueWei.toString(),
      chainId: row.chain_id,
      nftContract: row.nft_contract,
      tokenId: row.token_id,
      tokenStandard: row.token_standard,
      offerer: row.offerer,
      currency: row.currency,
      currencySymbol: cm.currencySymbol,
      currencyDecimals: cm.currencyDecimals,
      priceWei: row.price_wei,
      priceDecimal: formatPriceDecimal(row.price_wei, cm.currencyDecimals),
      expiresAt: Number(row.end_time),
      ...(hasTip ? { tipBps, tipRecipient: tipRecipientRaw } : {}),
    });
  }

  const succeeded = transactions.filter((t) => !t.error).length;
  const failed = transactions.filter((t) => t.error).length;

  return jsonResponse({
    transactions,
    succeeded,
    failed,
    total: transactions.length,
    // Total ETH/native value the buyer must send across all valid transactions
    totalValueWei: totalValueWei.toString(),
    // null if orders use mixed currencies (agent must sum per-currency themselves)
    currency: mixedCurrencies ? null : commonCurrency,
  });
}

// ─── GET /v1/orders/best-listing/fill-tx ────────────────────────────────────
//
// Floor-snipe shortcut: finds the cheapest active listing for a collection
// (or specific token) and returns the fill-tx in one call.
// Saves agents a round-trip vs. GET best-listing → GET fill-tx.
//
// Query params:
//   - chainId (required)
//   - collection (required)
//   - tokenId (optional): specific token, otherwise collection floor
//   - buyer (required): wallet address that will send the tx
//   - tipRecipient (optional)
//   - tipBps (optional)

export async function handleBestListingFillTx(ctx: RouteContext): Promise<Response> {
  const { params } = ctx;
  const chainIdRaw = params.get("chainId");
  const collection = params.get("collection")?.toLowerCase();
  const tokenId = params.get("tokenId");
  const buyer = params.get("buyer")?.toLowerCase();

  if (!chainIdRaw || !isValidChainId(chainIdRaw)) {
    return jsonError(400, "Missing or invalid chainId parameter");
  }
  if (!collection) return jsonError(400, "Missing required query param: collection");
  if (!isValidAddress(collection)) return jsonError(400, "Invalid collection address");
  if (!buyer) return jsonError(400, "Missing required query param: buyer");
  if (!isValidAddress(buyer)) return jsonError(400, "Invalid buyer address");

  const tipRecipientRaw = params.get("tipRecipient");
  const tipBpsRaw = params.get("tipBps");
  if ((tipRecipientRaw && !tipBpsRaw) || (!tipRecipientRaw && tipBpsRaw)) {
    return jsonError(400, "tipRecipient and tipBps must be provided together");
  }
  const hasTip = !!(tipRecipientRaw && tipBpsRaw);
  if (tipRecipientRaw && !isValidAddress(tipRecipientRaw)) {
    return jsonError(400, "Invalid tipRecipient address");
  }
  const tipBps = hasTip ? Number(tipBpsRaw) : 0;
  if (hasTip && (!Number.isFinite(tipBps) || tipBps <= 0 || tipBps > 10000)) {
    return jsonError(400, "tipBps must be between 1 and 10000");
  }

  const chainId = Number(chainIdRaw);
  const sql = getPooledSqlClient(ctx.env);
  const now = Math.floor(Date.now() / 1000);

  let rows: any[];
  try {
    if (tokenId) {
      rows = await sql`
        SELECT * FROM seaport_orders
        WHERE chain_id = ${chainId}
          AND nft_contract = ${collection}
          AND token_id = ${tokenId}
          AND order_type = 'listing'
          AND status = 'active'
          AND end_time > ${now}
          AND offerer != ${buyer}
        ORDER BY CAST(price_wei AS NUMERIC) ASC
        LIMIT 1
      `;
    } else {
      rows = await sql`
        SELECT * FROM seaport_orders
        WHERE chain_id = ${chainId}
          AND nft_contract = ${collection}
          AND order_type = 'listing'
          AND status = 'active'
          AND end_time > ${now}
          AND offerer != ${buyer}
        ORDER BY CAST(price_wei AS NUMERIC) ASC
        LIMIT 1
      `;
    }
  } catch (err: any) {
    console.error("[oob-api] best-listing/fill-tx: DB error:", err);
    return jsonError(500, "Failed to fetch best listing");
  }

  if (rows.length === 0) {
    return jsonError(404, {
      code: "NO_LISTING_FOUND",
      message: tokenId
        ? `No active listing found for token ${tokenId} in collection ${collection}`
        : `No active listings found for collection ${collection}`,
      collection,
      ...(tokenId ? { tokenId } : {}),
    });
  }

  const row = rows[0];
  let orderJson: any;
  try {
    orderJson = typeof row.order_json === "string" ? JSON.parse(row.order_json) : row.order_json;
  } catch {
    console.error("[oob-api] best-listing/fill-tx: malformed order_json for", row.order_hash);
    return jsonError(500, { code: "MALFORMED_ORDER", message: "Stored order data is malformed.", orderHash: row.order_hash });
  }
  const signature = row.signature as string;

  const isNativePayment = row.currency === "0x0000000000000000000000000000000000000000";
  let valueWei = 0n;
  if (isNativePayment) {
    for (const item of (orderJson.consideration || [])) {
      if (Number(item.itemType) === 0) valueWei += BigInt(item.startAmount);
    }
  }

  let calldata: string;
  try {
    if (hasTip) {
      const tipAmount = (BigInt(row.price_wei) * BigInt(tipBps)) / 10000n;
      if (tipAmount <= 0n) return jsonError(400, "Tip amount rounds to zero — increase tipBps");
      const tipItemType = isNativePayment ? 0 : 1;
      const tipToken = isNativePayment ? "0x0000000000000000000000000000000000000000" : row.currency;
      if (isNativePayment) valueWei += tipAmount;
      calldata = encodeFulfillAdvancedOrder(orderJson, signature, tipItemType, tipToken, tipAmount, tipRecipientRaw!);
    } else {
      calldata = encodeFulfillOrder(orderJson, signature);
    }
  } catch (err: any) {
    console.error("[oob-api] best-listing/fill-tx: encoding error:", err);
    return jsonError(500, {
      code: "CALLDATA_ENCODING_FAILED",
      message: "Failed to encode Seaport transaction calldata. The stored order data may be malformed.",
      orderHash: row.order_hash,
    });
  }

  const cm = resolveCurrency(row.chain_id, row.currency);

  return jsonResponse({
    to: SEAPORT_ADDRESS,
    data: calldata,
    value: valueWei.toString(),
    chainId: row.chain_id,
    orderHash: row.order_hash,
    orderType: row.order_type,
    nftContract: row.nft_contract,
    tokenId: row.token_id,
    tokenStandard: row.token_standard,
    offerer: row.offerer,
    currency: row.currency,
    currencySymbol: cm.currencySymbol,
    currencyDecimals: cm.currencyDecimals,
    priceWei: row.price_wei,
    priceDecimal: formatPriceDecimal(row.price_wei, cm.currencyDecimals),
    expiresAt: Number(row.end_time),
    expiresInSeconds: Number(row.end_time) - now,
    ...(Number(row.end_time) - now < 300 ? { warning: "This listing expires in less than 5 minutes. Broadcast quickly." } : {}),
    ...(hasTip ? { tipBps, tipRecipient: tipRecipientRaw } : {}),
  });
}

// ─── GET /v1/erc20/:token/approve-tx ────────────────────────────────────────
//
// Returns ready-to-sign ERC20 approval calldata for Seaport.
// Agents paying with WETH (or any ERC20) must approve Seaport before filling.
// This endpoint removes the need to know the ERC20 ABI.
//
// Path param:  :token  — ERC20 contract address
// Query params:
//   - spender (optional): defaults to Seaport address
//   - amount  (optional): approval amount in wei, defaults to MaxUint256
//
// Response:
//   { to, data, value, spender, amount, token }

const MAX_UINT256 = (2n ** 256n - 1n).toString();

export async function handleErc20ApproveTx(ctx: RouteContext): Promise<Response> {
  const token = ctx.segments[2]?.toLowerCase();
  if (!token || !isValidAddress(token)) {
    return jsonError(400, "Invalid or missing ERC20 token address in path");
  }

  const spender = (ctx.params.get("spender") ?? SEAPORT_ADDRESS).toLowerCase();
  if (!isValidAddress(spender)) return jsonError(400, "Invalid spender address");

  const amountRaw = ctx.params.get("amount") ?? MAX_UINT256;
  let amount: bigint;
  try {
    amount = BigInt(amountRaw);
    if (amount < 0n) throw new Error("negative");
  } catch {
    return jsonError(400, "Invalid amount — must be a non-negative integer string (wei)");
  }

  let calldata: string;
  try {
    calldata = encodeFunctionData({
      abi: ERC20_APPROVE_ABI,
      functionName: "approve",
      args: [spender as Address, amount],
    });
  } catch (err: any) {
    console.error("[oob-api] erc20/approve-tx: encoding error:", err);
    return jsonError(500, {
      code: "CALLDATA_ENCODING_FAILED",
      message: "Failed to encode ERC20 approve calldata.",
    });
  }

  return jsonResponse({
    to: token,
    data: calldata,
    value: "0",
    token,
    spender,
    amount: amount.toString(),
    isMaxApproval: amount === BigInt(MAX_UINT256),
    note: spender === SEAPORT_ADDRESS.toLowerCase()
      ? "This approves Seaport to spend your ERC20 tokens (e.g. WETH) when filling orders."
      : `This approves ${spender} to spend your ERC20 tokens.`,
  });
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

  const sql = getPooledSqlClient(ctx.env);
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

  if (!orderHash || !ORDER_HASH_RE.test(orderHash)) {
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
    const message = `cancel:${orderHash}`;
    const recovered = await recoverCancelSigner(message, cancelSig as Hex);
    if (recovered !== orderRows[0].offerer.toLowerCase()) {
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
