/**
 * Enhanced rate limiting using Upstash Redis.
 * 
 * Improvements over KV-based rate limiting:
 * - Atomic increment operations (no race conditions)
 * - Better performance with Redis data structures
 * - More precise rate limiting with sliding windows
 * - Built-in expiration handling
 */

import type { Env } from "./types.js";
import { jsonError } from "./response.js";

interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  limit: number;
  retryAfter?: number;
}

export class RedisRateLimit {
  public baseUrl: string;
  public token: string;

  constructor(env: Env) {
    if (!env.UPSTASH_REDIS_REST_URL || !env.UPSTASH_REDIS_REST_TOKEN) {
      throw new Error("Upstash Redis not configured for rate limiting");
    }
    this.baseUrl = env.UPSTASH_REDIS_REST_URL;
    this.token = env.UPSTASH_REDIS_REST_TOKEN;
  }

  /**
   * Check rate limit using Redis atomic operations.
   * Uses sliding window with multiple time buckets for smoother rate limiting.
   */
  async checkRateLimit(
    identifier: string,
    limit: number,
    windowSeconds: number,
    isWrite: boolean = false
  ): Promise<RateLimitResult> {
    try {
      const now = Date.now();
      const windowMs = windowSeconds * 1000;
      const bucketSize = windowMs / 4; // 4 buckets per window for smoother limiting
      const currentBucket = Math.floor(now / bucketSize);
      
      // Use Redis pipeline for atomic operations
      const pipeline = [
        // Increment current bucket
        ["HINCRBY", `rl:${identifier}`, currentBucket.toString(), "1"],
        // Set expiration on the hash (extends if already exists)
        ["EXPIRE", `rl:${identifier}`, windowSeconds * 2],
        // Get all buckets for this identifier
        ["HGETALL", `rl:${identifier}`],
      ];

      // Add burst limiting for writes (max 5 per second)
      // Pipeline indices when isWrite: 0=HINCRBY 1=EXPIRE 2=HGETALL 3=HINCRBY(burst) 4=EXPIRE(burst) 5=HGETALL(burst)
      if (isWrite) {
        const secondBucket = Math.floor(now / 1000);
        pipeline.push(
          ["HINCRBY", `rl:${identifier}:burst`, secondBucket.toString(), "1"],
          ["EXPIRE", `rl:${identifier}:burst`, "5"],
          ["HGETALL", `rl:${identifier}:burst`]
        );
      }

      const response = await fetch(`${this.baseUrl}/pipeline`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(pipeline),
      });

      if (!response.ok) {
        console.warn(`[rate-limit] Redis pipeline failed: ${response.status}`);
        return { allowed: true, remaining: limit, limit }; // Fail open
      }

      const results = await response.json() as { result: any }[];
      
      // Calculate total requests in sliding window
      const allBuckets = results[2]?.result || {};
      const cutoffBucket = currentBucket - 4; // Only count last 4 buckets
      
      let totalRequests = 0;
      for (const [bucketStr, countStr] of Object.entries(allBuckets)) {
        const bucket = parseInt(bucketStr);
        if (bucket > cutoffBucket) {
          totalRequests += parseInt(countStr as string) || 0;
        }
      }

      // Check burst limit for writes (HGETALL result is at index 5)
      if (isWrite && results.length > 5) {
        const burstBuckets = results[5]?.result || {};
        const currentSecond = Math.floor(now / 1000);
        const burstCount = parseInt(burstBuckets[currentSecond.toString()] || "0");
        
        if (burstCount > 5) {
          return {
            allowed: false,
            remaining: 0,
            limit,
            retryAfter: 1,
          };
        }
      }

      const allowed = totalRequests <= limit;
      const remaining = Math.max(0, limit - totalRequests);
      const retryAfter = allowed ? undefined : Math.ceil(bucketSize / 1000);

      return {
        allowed,
        remaining,
        limit,
        retryAfter,
      };
    } catch (err) {
      console.error("[rate-limit] Redis error (allowing request):", err);
      return { allowed: true, remaining: limit, limit }; // Fail open
    }
  }

  /**
   * Clean up rate limit keys that have no TTL set (should not happen normally,
   * but guards against keys left without expiry due to partial pipeline failures).
   * Paginates through all SCAN pages so no keys are missed.
   */
  async cleanup(): Promise<void> {
    try {
      let cursor = "0";
      const toDelete: string[] = [];

      do {
        const response = await fetch(
          `${this.baseUrl}/scan/${cursor}/match/rl:*/count/100`,
          { headers: { Authorization: `Bearer ${this.token}` } },
        );
        if (!response.ok) break;

        const data = await response.json() as { result: [string, string[]] | null };
        cursor = data.result?.[0] ?? "0";
        const keys = data.result?.[1] ?? [];

        // Collect keys with no expiry (TTL = -1); TTL = -2 means already expired/gone
        for (const key of keys) {
          const ttlResponse = await fetch(`${this.baseUrl}/ttl/${encodeURIComponent(key)}`, {
            headers: { Authorization: `Bearer ${this.token}` },
          });
          if (ttlResponse.ok) {
            const ttlData = await ttlResponse.json() as { result: number };
            if (ttlData.result === -1) toDelete.push(key); // no expiry set
          }
        }
      } while (cursor !== "0");

      // Batch-delete in one DEL call
      if (toDelete.length > 0) {
        await fetch(`${this.baseUrl}/del`, {
          method: "POST",
          headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
          body: JSON.stringify(toDelete),
        });
        console.log(`[rate-limit] Cleanup: removed ${toDelete.length} keys with no TTL`);
      }
    } catch (err) {
      console.error("[rate-limit] Cleanup error:", err);
    }
  }
}

/**
 * Enhanced rate limit check with Redis.
 */
export async function checkRateLimitRedis(
  request: Request,
  env: Env,
  isWrite: boolean,
): Promise<Response | null> {
  // Fallback to KV if Redis not configured
  if (!env.UPSTASH_REDIS_REST_URL || !env.UPSTASH_REDIS_REST_TOKEN) {
    const { checkRateLimit } = await import("./rateLimit.js");
    return checkRateLimit(request, env, isWrite);
  }

  try {
    const rateLimit = new RedisRateLimit(env);
    
    const apiKey = request.headers.get("X-API-Key");
    const isRegistered = apiKey ? isValidApiKey(apiKey, env) : false;

    // Hash API key before use as Redis identifier so the raw secret never
    // appears in Redis keyspace, Upstash REST URLs, or infrastructure logs.
    const rawIdentifier = (apiKey && isRegistered) ? apiKey : getClientIp(request);
    if (!rawIdentifier) return null; // Can't identify client
    const identifier = (apiKey && isRegistered)
      ? `k:${await hashIdentifier(apiKey)}`
      : `ip:${rawIdentifier}`;

    // Determine limit based on tier and request type
    const limit = getLimit(env, isRegistered, isWrite);
    const windowSeconds = 60; // 1 minute window

    const result = await rateLimit.checkRateLimit(identifier, limit, windowSeconds, isWrite);

    if (!result.allowed) {
      const res = jsonError(429, "Rate limit exceeded. Try again later.");
      res.headers.set("Retry-After", String(result.retryAfter || 60));
      res.headers.set("X-RateLimit-Limit", String(result.limit));
      res.headers.set("X-RateLimit-Remaining", "0");
      res.headers.set("X-RateLimit-Reset", String(Math.ceil(Date.now() / 1000) + (result.retryAfter || 60)));
      return res;
    }

    return null; // Allowed
  } catch (err) {
    console.error("[rate-limit] Redis rate limit error (allowing request):", err);
    return null; // Fail open
  }
}

/**
 * Add rate limit headers to response.
 */
export async function addRateLimitHeadersRedis(
  response: Response,
  request: Request,
  env: Env,
  isWrite: boolean,
): Promise<Response> {
  // Fallback to KV if Redis not configured
  if (!env.UPSTASH_REDIS_REST_URL || !env.UPSTASH_REDIS_REST_TOKEN) {
    const { addRateLimitHeaders } = await import("./rateLimit.js");
    return addRateLimitHeaders(response, request, env, isWrite);
  }

  try {
    const rateLimit = new RedisRateLimit(env);
    
    const apiKey = request.headers.get("X-API-Key");
    const isRegistered = apiKey ? isValidApiKey(apiKey, env) : false;
    const rawIdentifier = (apiKey && isRegistered) ? apiKey : getClientIp(request);
    if (!rawIdentifier) return response;
    const identifier = (apiKey && isRegistered)
      ? `k:${await hashIdentifier(apiKey)}`
      : `ip:${rawIdentifier}`;

    const limit = getLimit(env, isRegistered, isWrite);
    const windowSeconds = 60;

    // Get current usage (without incrementing)
    const bucketResponse = await fetch(`${rateLimit.baseUrl}/hgetall/rl:${identifier}`, {
      headers: {
        Authorization: `Bearer ${rateLimit.token}`,
      },
    });

    if (bucketResponse.ok) {
      const buckets = await bucketResponse.json() as { result: Record<string, string> };
      const now = Date.now();
      const windowMs = windowSeconds * 1000;
      const bucketSize = windowMs / 4; // must match checkRateLimit
      const currentBucket = Math.floor(now / bucketSize);
      const cutoffBucket = currentBucket - 4;
      
      let totalRequests = 0;
      for (const [bucketStr, countStr] of Object.entries(buckets.result || {})) {
        const bucket = parseInt(bucketStr);
        if (bucket > cutoffBucket) {
          totalRequests += parseInt(countStr) || 0;
        }
      }

      response.headers.set("X-RateLimit-Limit", String(limit));
      response.headers.set("X-RateLimit-Remaining", String(Math.max(0, limit - totalRequests)));
      response.headers.set("X-RateLimit-Reset", String(Math.ceil((currentBucket + 4) * bucketSize / 1000)));
    }
  } catch (err) {
    // Ignore errors in header decoration
  }

  return response;
}

// Helper functions (copied from rateLimit.ts)

/**
 * Hash a sensitive identifier (e.g. API key) with SHA-256 before using it
 * as a Redis key name or URL path segment, so the raw secret never appears
 * in Redis keyspace, Upstash logs, or infrastructure traces.
 */
async function hashIdentifier(value: string): Promise<string> {
  const encoded = new TextEncoder().encode(value);
  const hashBuffer = await crypto.subtle.digest("SHA-256", encoded);
  return Array.from(new Uint8Array(hashBuffer))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
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
