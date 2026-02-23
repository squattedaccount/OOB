/**
 * OOB Indexer — Cloudflare Worker Entry Point
 *
 * Standalone indexer for the Open Order Book. Monitors Seaport v1.6 on-chain
 * events and manages order lifecycle in the OOB Neon Postgres database.
 *
 * Responsibilities:
 *   1. Receive webhook events (Alchemy/Moralis/Goldsky) for Seaport contracts
 *   2. Update order statuses: filled, cancelled, counter-incremented
 *   3. Cron: expire past-endTime orders + detect stale listings (NFT transferred)
 *
 * Routes:
 *   POST /webhook          — Receive on-chain log events
 *   POST /webhook/alchemy  — Alchemy Notify webhook
 *   POST /webhook/moralis  — Moralis Streams webhook
 *   POST /webhook/goldsky  — Goldsky Mirror webhook
 *   GET  /health           — Health check
 *   GET  /status           — Indexer status (order counts by status)
 */

import type { Env } from "./types.js";
import { getSqlClient } from "./db.js";
import { handleWebhook } from "./webhook.js";
import { handleCron } from "./cron.js";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "");

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization, x-webhook-secret",
          "Access-Control-Max-Age": "86400",
        },
      });
    }

    // Health check
    if (path === "/health" && request.method === "GET") {
      return jsonResponse({ status: "healthy", service: "oob-indexer" });
    }

    // Status endpoint — order counts by status
    if (path === "/status" && request.method === "GET") {
      return handleStatus(env);
    }

    // Webhook endpoints — all POST
    if (request.method === "POST" && path.startsWith("/webhook")) {
      const sql = getSqlClient(env.DATABASE_URL);
      return handleWebhook(request, env, sql);
    }

    return jsonResponse({ error: "Not found" }, 404);
  },

  async scheduled(_event: unknown, env: Env, ctx: { waitUntil: (p: Promise<unknown>) => void }): Promise<void> {
    ctx.waitUntil(runCron(env));
  },
};

async function runCron(env: Env): Promise<void> {
  const startMs = Date.now();
  let lockValue: string | null = null;
  let lock: import("./lock.js").IndexerLock | null = null;

  try {
    // Try to acquire distributed lock to prevent multiple indexer instances from running simultaneously
    if (env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN) {
      const { IndexerLock } = await import("./lock.js");
      lock = new IndexerLock(env);
      lockValue = await lock.acquire("indexer-cron", 300); // 5 minute lock
      if (!lockValue) {
        console.log("[oob-indexer] Cron already running on another instance, skipping");
        return;
      }
      console.log("[oob-indexer] Acquired cron lock, starting indexer tasks");
    }

    const sql = getSqlClient(env.DATABASE_URL);
    const result = await handleCron(sql, env);
    const durationMs = Date.now() - startMs;
    console.log(
      `[oob-indexer] Cron finished in ${durationMs}ms: ` +
        `expired=${result.expired} stale=${result.staleDetected} errors=${result.errors.length}`,
    );
  } catch (err) {
    console.error("[oob-indexer] Cron failed:", err);
  } finally {
    // Always release the lock using the same instance acquired above
    if (lock && lockValue) {
      try {
        await lock.release("indexer-cron", lockValue);
        console.log("[oob-indexer] Released cron lock");
      } catch (lockErr) {
        console.error("[oob-indexer] Failed to release cron lock:", lockErr);
      }
    }
  }
}

async function handleStatus(env: Env): Promise<Response> {
  try {
    const sql = getSqlClient(env.DATABASE_URL);
    const rows = await sql`
      SELECT status, COUNT(*)::int as count
      FROM seaport_orders
      GROUP BY status
      ORDER BY count DESC
    `;
    const statusCounts: Record<string, number> = {};
    for (const row of Array.isArray(rows) ? rows : []) {
      statusCounts[row.status] = row.count;
    }
    const total = Object.values(statusCounts).reduce((a, b) => a + b, 0);
    return jsonResponse({
      service: "oob-indexer",
      orders: { total, ...statusCounts },
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Gracefully handle missing table
    if (msg.includes("does not exist")) {
      return jsonResponse({
        service: "oob-indexer",
        orders: { total: 0 },
        message: "seaport_orders table not found — run migration first",
        timestamp: new Date().toISOString(),
      });
    }
    return jsonResponse({ error: "Failed to query status", message: msg }, 500);
  }
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
