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
 *   POST   /v1/orders                    — Submit a signed order
 *   DELETE  /v1/orders/:hash             — Cancel an order
 *   GET    /v1/collections/:addr/stats   — Collection floor, offer count, etc.
 *   GET    /health                       — Health check
 */

import type { Env, RouteContext } from "./types.js";
import { jsonResponse, jsonError, corsPreflightResponse } from "./response.js";
import { checkRateLimit, addRateLimitHeaders } from "./rateLimit.js";
import {
  handleGetOrders,
  handleGetOrder,
  handleBestListing,
  handleBestOffer,
  handleSubmitOrder,
  handleCancelOrder,
  handleCollectionStats,
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
  if (!env.ORDER_STREAM) {
    return jsonError(503, "WebSocket streams not configured");
  }

  const upgradeHeader = request.headers.get("Upgrade");
  if (upgradeHeader !== "websocket") {
    return jsonError(426, "Expected WebSocket upgrade");
  }

  // Route to a Durable Object based on chainId + collection (or "all")
  const chainId = params.get("chainId") || "all";
  const collection = params.get("collection")?.toLowerCase() || "all";
  const roomId = `${chainId}:${collection}`;

  const id = env.ORDER_STREAM.idFromName(roomId);
  const stub = env.ORDER_STREAM.get(id);

  // Forward the request to the Durable Object
  return stub.fetch(request);
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
    // GET /v1/orders/best-listing
    if (segments[2] === "best-listing" && method === "GET") {
      return handleBestListing(ctx);
    }

    // GET /v1/orders/best-offer
    if (segments[2] === "best-offer" && method === "GET") {
      return handleBestOffer(ctx);
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

  // ─── /v1/collections/:address/stats ─────────────────────────────────

  if (resource === "collections" && segments[3] === "stats" && method === "GET") {
    return handleCollectionStats(ctx);
  }

  return jsonError(404, "Not found");
}
