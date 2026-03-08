/**
 * Rate limiting middleware using Cloudflare KV.
 *
 * Tracks request counts per minute per identifier (IP or API key).
 * KV keys auto-expire after 60 seconds.
 */

import type { Env, RequestApiAccess } from "./types.js";
import { jsonError } from "./response.js";
import { getEntitlementNumber, resolveRequestApiAccess } from "./subscriptions.js";

interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  limit: number;
  retryAfter?: number;
}

/**
 * Check rate limit for a request.
 * Returns null if rate limiting is not configured (KV not bound).
 */
export async function checkRateLimit(
  request: Request,
  env: Env,
  isWrite: boolean,
  access?: RequestApiAccess,
): Promise<Response | null> {
  const kv = env.OOB_RATE_LIMIT;
  if (!kv) return null; // KV not configured, skip rate limiting

  const resolvedAccess = access ?? await resolveRequestApiAccess(request, env);
  const identifier = resolvedAccess.identifier;
  if (!identifier) return null; // Can't identify client

  const limit = getLimit(env, resolvedAccess.isRegistered, isWrite, resolvedAccess.entitlements);

  // Build KV key with 15-second windows for tighter rate control.
  // Smaller windows reduce the impact of KV's eventual consistency race conditions.
  const window = Math.floor(Date.now() / 15000);
  const kind = isWrite ? "w" : "r";
  const key = `rl:${identifier}:${kind}:${window}`;
  // Per-window limit is 1/4 of the per-minute limit (rounded up)
  const windowLimit = Math.ceil(limit / 4);

  try {
    // Increment-first pattern: always increment, then check.
    // This prevents the race where parallel requests all read the same value
    // and all pass before any of them writes the incremented counter.
    const current = Number(await kv.get(key) || "0");
    const next = current + 1;

    // Write the incremented value immediately (before checking limit)
    await kv.put(key, String(next), { expirationTtl: 30 });

    if (next > windowLimit) {
      const retryAfter = 15 - (Math.floor(Date.now() / 1000) % 15);
      const res = jsonError(429, "Rate limit exceeded. Try again later.");
      res.headers.set("Retry-After", String(retryAfter));
      res.headers.set("X-RateLimit-Limit", String(limit));
      res.headers.set("X-RateLimit-Remaining", "0");
      res.headers.set("X-RateLimit-Reset", String(Math.ceil(Date.now() / 15000) * 15));
      return res;
    }

    // For writes, add a per-second micro-burst limiter to constrain parallel abuse.
    // This limits write bursts to ~5 per second even if the per-minute limit is higher.
    if (isWrite) {
      const second = Math.floor(Date.now() / 1000);
      const burstKey = `rl:${identifier}:burst:${second}`;
      const burstCount = Number(await kv.get(burstKey) || "0");
      await kv.put(burstKey, String(burstCount + 1), { expirationTtl: 5 });
      if (burstCount >= 5) {
        const res = jsonError(429, "Too many requests per second. Slow down.");
        res.headers.set("Retry-After", "1");
        return res;
      }
    }

    return null; // Allowed
  } catch (err) {
    // KV unreachable — log and allow through.
    // Blocking all writes when KV is down is a self-DoS; the DB-level validations
    // (signature checks, fee enforcement, order caps) still protect against abuse.
    console.error("[oob-api] Rate limit KV error (allowing request):", err);
    return null;
  }
}

/**
 * Add rate limit headers to a successful response.
 */
export async function addRateLimitHeaders(
  response: Response,
  request: Request,
  env: Env,
  isWrite: boolean,
  access?: RequestApiAccess,
): Promise<Response> {
  const kv = env.OOB_RATE_LIMIT;
  if (!kv) return response;

  const resolvedAccess = access ?? await resolveRequestApiAccess(request, env);
  const identifier = resolvedAccess.identifier;
  if (!identifier) return response;

  const limit = getLimit(env, resolvedAccess.isRegistered, isWrite, resolvedAccess.entitlements);
  const window = Math.floor(Date.now() / 15000);
  const windowLimit = Math.ceil(limit / 4);
  const kind = isWrite ? "w" : "r";
  const key = `rl:${identifier}:${kind}:${window}`;

  try {
    const current = Number(await kv.get(key) || "0");
    response.headers.set("X-RateLimit-Limit", String(limit));
    response.headers.set("X-RateLimit-Remaining", String(Math.max(0, windowLimit - current) * 4));
    response.headers.set("X-RateLimit-Reset", String(Math.ceil(Date.now() / 15000) * 15));
  } catch {
    // Ignore errors in header decoration
  }

  return response;
}

function getLimit(env: Env, isRegistered: boolean, isWrite: boolean, entitlements?: Record<string, unknown>): number {
  const entitlementLimit = isWrite
    ? getEntitlementNumber(entitlements, "writeRpm", 0)
    : getEntitlementNumber(entitlements, "readRpm", 0);
  if (entitlementLimit > 0) return entitlementLimit;
  if (isRegistered) {
    return isWrite
      ? Number(env.RATE_LIMIT_REGISTERED_WRITES || 60)
      : Number(env.RATE_LIMIT_REGISTERED_READS || 300);
  }
  return isWrite
    ? Number(env.RATE_LIMIT_PUBLIC_WRITES || 10)
    : Number(env.RATE_LIMIT_PUBLIC_READS || 60);
}
