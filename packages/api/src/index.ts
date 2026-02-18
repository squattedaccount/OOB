/**
 * Open Order Book API — Cloudflare Worker
 *
 * Public REST API for reading, submitting, and cancelling Seaport v1.6 orders.
 * Connects directly to the same Neon Postgres database as the nodz indexer.
 *
 * Routes:
 *   GET    /v1/orders                    — Query orders with filters
 *   GET    /v1/orders/best-listing       — Cheapest active listing
 *   GET    /v1/orders/best-offer         — Highest active offer
 *   GET    /v1/orders/:hash              — Get single order by hash
 *   GET    /v1/orders/:hash/fill-tx      — Ready-to-sign fill transaction
 *   POST   /v1/orders                    — Submit a signed order
 *   POST   /v1/orders/batch             — Batch submit up to 20 orders
 *   POST   /v1/orders/batch/fill-tx     — Batch fill-tx (sweep up to 20 orders)
 *   DELETE  /v1/orders/:hash             — Cancel an order
 *   DELETE  /v1/orders/batch             — Batch cancel up to 20 orders
 *   GET    /v1/orders/best-listing/fill-tx — Floor snipe shortcut
 *   GET    /v1/collections/:addr/stats   — Collection floor, offer count, etc.
 *   GET    /v1/erc20/:token/approve-tx   — ERC20 approval calldata for Seaport
 *   GET    /v1/config                    — Protocol fee config (for SDK)
 *   GET    /health                       — Health check
 */

import type { Env, RouteContext } from "./types.js";
import { jsonResponse, jsonError, corsPreflightResponse } from "./response.js";
import { checkRateLimit, addRateLimitHeaders } from "./rateLimit.js";
import { logRequestAudit } from "./audit.js";
import {
  handleGetOrders,
  handleGetOrder,
  handleBestListing,
  handleBestOffer,
  handleSubmitOrder,
  handleCancelOrder,
  handleBatchSubmitOrders,
  handleBatchCancelOrders,
  handleCollectionStats,
  handleGetActivity,
  handleFillTx,
  handleBatchFillTx,
  handleBestListingFillTx,
  handleErc20ApproveTx,
} from "./routes/orders.js";

export { OrderStreamDO } from "./stream.js";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Handle CORS preflight
    if (request.method === "OPTIONS") {
      return corsPreflightResponse();
    }

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, ""); // strip trailing slash
    const segments = path.split("/").filter(Boolean);
    const params = url.searchParams;

    // WebSocket upgrade for /v1/stream
    if (segments[0] === "v1" && segments[1] === "stream") {
      return handleStreamUpgrade(request, env, params);
    }

    const isWrite = request.method === "POST" || request.method === "DELETE";

    // Audit log write operations
    if (isWrite) {
      logRequestAudit(request, env, url.pathname);
    }

    // Rate limiting
    const rateLimitResponse = await checkRateLimit(request, env, isWrite);
    if (rateLimitResponse) return rateLimitResponse;

    const ctx: RouteContext = { request, env, url, segments, params };

    try {
      const response = await route(ctx, segments, request.method);
      return addRateLimitHeaders(response, request, env, isWrite);
    } catch (err: any) {
      console.error("[oob-api] Unhandled error:", err);
      return jsonError(500, "Internal server error");
    }
  },
};

async function handleStreamUpgrade(
  request: Request,
  env: Env,
  params: URLSearchParams,
): Promise<Response> {
  // Apply rate limiting to websocket upgrades as well.
  // Treat as write-tier to keep connection floods tightly constrained.
  const rateLimitResponse = await checkRateLimit(request, env, true);
  if (rateLimitResponse) return rateLimitResponse;

  if (!env.ORDER_STREAM) {
    return jsonError(503, "WebSocket streams not configured");
  }

  const upgradeHeader = request.headers.get("Upgrade")?.toLowerCase();
  if (upgradeHeader !== "websocket") {
    return jsonError(426, "Expected WebSocket upgrade");
  }

  // Route to a Durable Object based on chainId + collection (or "all")
  const chainId = params.get("chainId") || "all";
  const collection = params.get("collection")?.toLowerCase() || "all";
  const roomId = `${chainId}:${collection}`;

  // Sharding: distribute clients across N DO instances per room.
  // DO_SHARD_COUNT=1 (default) means no sharding — single DO per room.
  // Set DO_SHARD_COUNT=4 for high-traffic collections (e.g. >500 concurrent clients).
  // Each shard is an independent DO; broadcaster fans out to all shards.
  const shardCount = Math.max(1, parseInt(env.DO_SHARD_COUNT || "1", 10));
  const shard = shardCount === 1 ? 0 : pickShard(request, shardCount);
  const shardedRoomId = shardCount === 1 ? roomId : `${roomId}:s${shard}`;

  const id = env.ORDER_STREAM.idFromName(shardedRoomId);
  const stub = env.ORDER_STREAM.get(id);

  // Forward the request to the Durable Object
  return stub.fetch(request);
}

/**
 * Pick a shard index for a connecting client.
 * Uses CF-Connecting-IP for sticky routing (same IP → same shard),
 * which avoids unnecessary cross-shard reconnects on refresh.
 */
function pickShard(request: Request, shardCount: number): number {
  const ip = request.headers.get("CF-Connecting-IP") || Math.random().toString();
  let hash = 0;
  for (let i = 0; i < ip.length; i++) {
    hash = (hash * 31 + ip.charCodeAt(i)) >>> 0; // unsigned 32-bit
  }
  return hash % shardCount;
}

async function route(
  ctx: RouteContext,
  segments: string[],
  method: string,
): Promise<Response> {
  // Health check
  if (segments[0] === "health") {
    return jsonResponse({ status: "healthy", service: "oob-api" });
  }

  // All API routes start with /v1
  if (segments[0] !== "v1") {
    return jsonError(404, `Unknown path. API routes start with /v1`);
  }

  const resource = segments[1]; // "orders" | "collections"

  // ─── /v1/orders ─────────────────────────────────────────────────────

  if (resource === "orders") {
    // POST /v1/orders/batch/fill-tx (sweep)
    if (segments[2] === "batch" && segments[3] === "fill-tx" && method === "POST") {
      return handleBatchFillTx(ctx);
    }

    // POST /v1/orders/batch (batch submit)
    if (segments[2] === "batch" && method === "POST") {
      return handleBatchSubmitOrders(ctx);
    }

    // DELETE /v1/orders/batch (batch cancel)
    if (segments[2] === "batch" && method === "DELETE") {
      return handleBatchCancelOrders(ctx);
    }

    // GET /v1/orders/best-listing/fill-tx (floor snipe shortcut)
    if (segments[2] === "best-listing" && segments[3] === "fill-tx" && method === "GET") {
      return handleBestListingFillTx(ctx);
    }

    // GET /v1/orders/best-listing
    if (segments[2] === "best-listing" && method === "GET") {
      return handleBestListing(ctx);
    }

    // GET /v1/orders/best-offer
    if (segments[2] === "best-offer" && method === "GET") {
      return handleBestOffer(ctx);
    }

    // GET /v1/orders/:hash/activity
    if (segments[2] && segments[3] === "activity" && segments.length === 4 && method === "GET") {
      // Rewrite as /v1/activity?orderHash=:hash for convenience
      ctx.params.set("orderHash", segments[2]);
      return handleGetActivity(ctx);
    }

    // GET /v1/orders/:hash/fill-tx
    if (segments[2] && segments[3] === "fill-tx" && segments.length === 4 && method === "GET") {
      return handleFillTx(ctx);
    }

    // GET /v1/orders/:hash (must be a hash, not a sub-route)
    if (segments[2] && segments.length === 3 && method === "GET") {
      return handleGetOrder(ctx);
    }

    // DELETE /v1/orders/:hash
    if (segments[2] && segments.length === 3 && method === "DELETE") {
      return handleCancelOrder(ctx);
    }

    // GET /v1/orders (list/query)
    if (!segments[2] && method === "GET") {
      return handleGetOrders(ctx);
    }

    // POST /v1/orders (submit)
    if (!segments[2] && method === "POST") {
      return handleSubmitOrder(ctx);
    }
  }

  // ─── /v1/activity ──────────────────────────────────────────────────

  if (resource === "activity" && method === "GET") {
    return handleGetActivity(ctx);
  }

  // ─── /v1/config ─────────────────────────────────────────────────

  if (resource === "config" && method === "GET") {
    if (!ctx.env.PROTOCOL_FEE_RECIPIENT) {
      return jsonError(503, "Protocol fee recipient is not configured");
    }
    return jsonResponse({
      protocolFeeBps: Number(ctx.env.PROTOCOL_FEE_BPS || "50"),
      protocolFeeRecipient: ctx.env.PROTOCOL_FEE_RECIPIENT || "",
    });
  }

  // ─── /v1/erc20/:token/approve-tx ──────────────────────────────────────

  if (resource === "erc20" && segments[3] === "approve-tx" && method === "GET") {
    return handleErc20ApproveTx(ctx);
  }

  // ─── /v1/collections/:address/stats ─────────────────────────────────

  if (resource === "collections" && segments[3] === "stats" && method === "GET") {
    return handleCollectionStats(ctx);
  }

  return jsonError(404, "Not found");
}
