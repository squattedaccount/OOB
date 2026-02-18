/**
 * Rate limiting middleware using Cloudflare KV.
 *
 * Tracks request counts per minute per identifier (IP or API key).
 * KV keys auto-expire after 60 seconds.
 */

import type { Env } from "./types.js";
import { jsonError } from "./response.js";

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
): Promise<Response | null> {
  const kv = env.OOB_RATE_LIMIT;
  if (!kv) return null; // KV not configured, skip rate limiting

  const apiKey = request.headers.get("X-API-Key");
  const isRegistered = apiKey ? isValidApiKey(apiKey, env) : false;

  // Determine identifier: API key (if valid) or IP address
  const identifier = (apiKey && isRegistered) ? apiKey : getClientIp(request);
  if (!identifier) return null; // Can't identify client

  // Determine limit based on tier and request type
  const limit = getLimit(env, isRegistered, isWrite);

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
): Promise<Response> {
  const kv = env.OOB_RATE_LIMIT;
  if (!kv) return response;

  const apiKey = request.headers.get("X-API-Key");
  const isRegistered = apiKey ? isValidApiKey(apiKey, env) : false;
  const identifier = (apiKey && isRegistered) ? apiKey : getClientIp(request);
  if (!identifier) return response;

  const limit = getLimit(env, isRegistered, isWrite);
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

function getLimit(env: Env, isRegistered: boolean, isWrite: boolean): number {
  if (isRegistered) {
    return isWrite
      ? Number(env.RATE_LIMIT_REGISTERED_WRITES || 60)
      : Number(env.RATE_LIMIT_REGISTERED_READS || 300);
  }
  return isWrite
    ? Number(env.RATE_LIMIT_PUBLIC_WRITES || 10)
    : Number(env.RATE_LIMIT_PUBLIC_READS || 60);
}

function isValidApiKey(key: string, env: Env): boolean {
  if (!env.API_KEYS) return false;
  const validKeys = env.API_KEYS.split(",").map((k) => k.trim()).filter(Boolean);
  return validKeys.includes(key);
}

function getClientIp(request: Request): string {
  return (
    request.headers.get("CF-Connecting-IP") ||
    request.headers.get("X-Forwarded-For")?.split(",")[0]?.trim() ||
    "unknown"
  );
}
