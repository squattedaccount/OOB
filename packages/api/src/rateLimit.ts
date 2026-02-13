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
  const isRegistered = !!apiKey;

  // Determine identifier: API key or IP address
  const identifier = apiKey || getClientIp(request);
  if (!identifier) return null; // Can't identify client

  // Determine limit based on tier and request type
  const limit = getLimit(env, isRegistered, isWrite);

  // Build KV key: ratelimit:{identifier}:{read|write}:{minute}
  const minute = Math.floor(Date.now() / 60000);
  const kind = isWrite ? "w" : "r";
  const key = `rl:${identifier}:${kind}:${minute}`;

  try {
    const current = Number(await kv.get(key) || "0");

    if (current >= limit) {
      const retryAfter = 60 - (Math.floor(Date.now() / 1000) % 60);
      const res = jsonError(429, "Rate limit exceeded. Try again later.");
      res.headers.set("Retry-After", String(retryAfter));
      res.headers.set("X-RateLimit-Limit", String(limit));
      res.headers.set("X-RateLimit-Remaining", "0");
      res.headers.set("X-RateLimit-Reset", String(Math.ceil(Date.now() / 60000) * 60));
      return res;
    }

    // Increment counter (fire-and-forget for performance)
    // TTL of 120s ensures cleanup even if the minute boundary shifts
    await kv.put(key, String(current + 1), { expirationTtl: 120 });

    return null; // Allowed
  } catch (err) {
    // If KV fails, allow the request (fail open)
    console.error("[oob-api] Rate limit check failed:", err);
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
  const isRegistered = !!apiKey;
  const identifier = apiKey || getClientIp(request);
  if (!identifier) return response;

  const limit = getLimit(env, isRegistered, isWrite);
  const minute = Math.floor(Date.now() / 60000);
  const kind = isWrite ? "w" : "r";
  const key = `rl:${identifier}:${kind}:${minute}`;

  try {
    const current = Number(await kv.get(key) || "0");
    response.headers.set("X-RateLimit-Limit", String(limit));
    response.headers.set("X-RateLimit-Remaining", String(Math.max(0, limit - current)));
    response.headers.set("X-RateLimit-Reset", String(Math.ceil(Date.now() / 60000) * 60));
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

function getClientIp(request: Request): string {
  return (
    request.headers.get("CF-Connecting-IP") ||
    request.headers.get("X-Forwarded-For")?.split(",")[0]?.trim() ||
    "unknown"
  );
}
