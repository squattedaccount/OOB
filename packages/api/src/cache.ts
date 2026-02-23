/**
 * Hot cache layer using Upstash Redis.
 * 
 * Provides write-through caching for frequently accessed endpoints:
 * - best-listing queries (10s TTL)
 * - collection stats (30s TTL) 
 * - individual orders (60s TTL)
 * - order list queries (5s TTL)
 */

import type { Env } from "./types.js";

interface CacheConfig {
  ttl: number; // seconds
  keyPrefix: string;
}

// Namespace prefix isolates OOB keys from any other data in the same Redis instance.
const NS = "oob";

const CACHE_CONFIGS: Record<string, CacheConfig> = {
  bestListing: { ttl: 10, keyPrefix: `${NS}:best-listing` },
  collectionStats: { ttl: 30, keyPrefix: `${NS}:stats` },
  order: { ttl: 60, keyPrefix: `${NS}:order` },
  ordersList: { ttl: 5, keyPrefix: `${NS}:orders` },
};

export class RedisCache {
  private baseUrl: string;
  private token: string;

  constructor(env: Env) {
    if (!env.UPSTASH_REDIS_REST_URL || !env.UPSTASH_REDIS_REST_TOKEN) {
      throw new Error("Upstash Redis not configured");
    }
    this.baseUrl = env.UPSTASH_REDIS_REST_URL;
    this.token = env.UPSTASH_REDIS_REST_TOKEN;
  }

  /**
   * Get cached value by key.
   * Returns null if key doesn't exist or cache is unavailable.
   */
  async get<T>(key: string): Promise<T | null> {
    try {
      const response = await fetch(`${this.baseUrl}/get/${encodeURIComponent(key)}`, {
        headers: {
          Authorization: `Bearer ${this.token}`,
        },
      });

      if (!response.ok) {
        console.warn(`[cache] GET failed for key ${key}: ${response.status}`);
        return null;
      }

      const data = await response.json() as { result: string | null };
      if (data.result === null) {
        return null;
      }

      return JSON.parse(data.result) as T;
    } catch (err) {
      console.error(`[cache] GET error for key ${key}:`, err);
      return null;
    }
  }

  /**
   * Set cached value with TTL.
   */
  async set(key: string, value: any, ttlSeconds: number): Promise<void> {
    try {
      const response = await fetch(`${this.baseUrl}/setex/${encodeURIComponent(key)}/${ttlSeconds}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(value),
      });

      if (!response.ok) {
        console.warn(`[cache] SET failed for key ${key}: ${response.status}`);
      }
    } catch (err) {
      console.error(`[cache] SET error for key ${key}:`, err);
    }
  }

  /**
   * Delete cached value(s) by key pattern.
   * Supports wildcards for cache invalidation.
   */
  async del(keyPattern: string): Promise<void> {
    try {
      // If it's a simple key (no wildcards), use direct DELETE
      if (!keyPattern.includes("*")) {
        const response = await fetch(`${this.baseUrl}/del/${encodeURIComponent(keyPattern)}`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.token}`,
          },
        });

        if (!response.ok) {
          console.warn(`[cache] DEL failed for key ${keyPattern}: ${response.status}`);
        }
        return;
      }

      // For wildcard patterns, use SCAN (paginating all cursor pages) + DEL
      const allKeys: string[] = [];
      let cursor = "0";

      do {
        const scanResponse = await fetch(
          `${this.baseUrl}/scan/${cursor}/match/${encodeURIComponent(keyPattern)}/count/100`,
          { headers: { Authorization: `Bearer ${this.token}` } },
        );

        if (!scanResponse.ok) {
          console.warn(`[cache] SCAN failed for pattern ${keyPattern}: ${scanResponse.status}`);
          break;
        }

        const scanData = await scanResponse.json() as { result: [string, string[]] | null };
        cursor = scanData.result?.[0] ?? "0";
        const page = scanData.result?.[1] ?? [];
        allKeys.push(...page);
      } while (cursor !== "0");

      if (allKeys.length > 0) {
        const delResponse = await fetch(`${this.baseUrl}/del`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(allKeys),
        });

        if (!delResponse.ok) {
          console.warn(`[cache] Batch DEL failed for pattern ${keyPattern}: ${delResponse.status}`);
        }
      }
    } catch (err) {
      console.error(`[cache] DEL error for pattern ${keyPattern}:`, err);
    }
  }

  /**
   * Get or set pattern: try cache first, fallback to fetcher function.
   * Pass shouldCache to suppress caching specific results (e.g. not-found sentinels).
   */
  async getOrSet<T>(
    key: string,
    fetcher: () => Promise<T>,
    config: CacheConfig,
    shouldCache: (data: T) => boolean = () => true,
  ): Promise<T> {
    // Try cache first
    const cached = await this.get<T>(key);
    if (cached !== null) {
      return cached;
    }

    // Cache miss - fetch from source
    const data = await fetcher();

    // Only cache if the result is worth caching (e.g. skip not-found sentinels)
    if (shouldCache(data)) {
      this.set(key, data, config.ttl).catch(() => {
        // Ignore cache write errors - don't block the response
      });
    }

    return data;
  }

  /**
   * Order deduplication using Redis SET NX.
   * Returns:
   *   "new"       — key was set, this is the first submission (proceed)
   *   "duplicate" — key already existed (reject as duplicate)
   *   "error"     — Redis unavailable (caller must fall back to DB check)
   */
  async deduplicate(orderHash: string, ttlSeconds: number = 300): Promise<"new" | "duplicate" | "error"> {
    try {
      const key = `${NS}:dedup:${orderHash}`;
      
      // Use SET with NX (only set if not exists) and EX (expiration)
      const response = await fetch(`${this.baseUrl}/set/${encodeURIComponent(key)}/1/ex/${ttlSeconds}/nx`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.token}`,
        },
      });

      if (!response.ok) {
        console.warn(`[cache] Deduplication SET failed for ${orderHash}: ${response.status}`);
        return "error";
      }

      const data = await response.json() as { result: string | null };
      // "OK" → key was set (first submission)
      // null → key already existed (duplicate)
      return data.result === "OK" ? "new" : "duplicate";
    } catch (err) {
      console.error(`[cache] Deduplication error for ${orderHash}:`, err);
      return "error";
    }
  }

  /**
   * Check if an order hash is in the deduplication set.
   */
  async isDuplicate(orderHash: string): Promise<boolean> {
    try {
      const key = `${NS}:dedup:${orderHash}`;
      const response = await fetch(`${this.baseUrl}/exists/${encodeURIComponent(key)}`, {
        headers: {
          Authorization: `Bearer ${this.token}`,
        },
      });

      if (!response.ok) {
        console.warn(`[cache] Deduplication EXISTS failed for ${orderHash}: ${response.status}`);
        return false; // Assume not duplicate on error
      }

      const data = await response.json() as { result: number };
      return data.result === 1; // 1 means key exists, 0 means it doesn't
    } catch (err) {
      console.error(`[cache] Deduplication check error for ${orderHash}:`, err);
      return false; // Assume not duplicate on error
    }
  }

  /**
   * Distributed locking for indexer coordination.
   * Prevents multiple indexer instances from processing the same data simultaneously.
   */
  async acquireLock(lockKey: string, ttlSeconds: number = 60, retryDelayMs: number = 100): Promise<string | null> {
    try {
      const randomBytes = new Uint8Array(16);
      crypto.getRandomValues(randomBytes);
      const lockValue = Array.from(randomBytes, b => b.toString(16).padStart(2, "0")).join("");
      const key = `${NS}:lock:${lockKey}`;
      
      // Use SET with NX (only set if not exists) and EX (expiration)
      const response = await fetch(`${this.baseUrl}/set/${encodeURIComponent(key)}/${encodeURIComponent(lockValue)}/ex/${ttlSeconds}/nx`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.token}`,
        },
      });

      if (!response.ok) {
        console.warn(`[cache] Lock acquisition failed for ${lockKey}: ${response.status}`);
        return null;
      }

      const data = await response.json() as { result: string | null };
      // If result is "OK", we acquired the lock
      if (data.result === "OK") {
        return lockValue;
      }
      
      return null; // Lock already held by someone else
    } catch (err) {
      console.error(`[cache] Lock acquisition error for ${lockKey}:`, err);
      return null;
    }
  }

  /**
   * Release a distributed lock.
   * Only releases if we own the lock (prevents accidental releases).
   */
  async releaseLock(lockKey: string, lockValue: string): Promise<boolean> {
    try {
      const key = `${NS}:lock:${lockKey}`;
      
      // Lua script for atomic compare-and-delete
      const luaScript = `
        if redis.call("GET", KEYS[1]) == ARGV[1] then
          return redis.call("DEL", KEYS[1])
        else
          return 0
        end
      `;
      
      const response = await fetch(`${this.baseUrl}/eval`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          script: luaScript,
          keys: [key],
          args: [lockValue],
        }),
      });

      if (!response.ok) {
        console.warn(`[cache] Lock release failed for ${lockKey}: ${response.status}`);
        return false;
      }

      const data = await response.json() as { result: number };
      return data.result === 1; // 1 means lock was released, 0 means we didn't own it
    } catch (err) {
      console.error(`[cache] Lock release error for ${lockKey}:`, err);
      return false;
    }
  }

  /**
   * Mark an order as "pending fill" using SET NX with TTL.
   * Returns true if this caller set the flag (first to claim), false if already pending.
   * Fails open (returns false) if Redis is unavailable — callers must handle gracefully.
   */
  async setPending(orderHash: string, ttlSeconds: number = 30): Promise<boolean> {
    try {
      const key = `${NS}:pending:${orderHash}`;
      const response = await fetch(
        `${this.baseUrl}/set/${encodeURIComponent(key)}/1/ex/${ttlSeconds}/nx`,
        { method: "POST", headers: { Authorization: `Bearer ${this.token}` } },
      );
      if (!response.ok) return false;
      const data = await response.json() as { result: string | null };
      return data.result === "OK";
    } catch {
      return false;
    }
  }

  /**
   * Check if an order is currently marked as pending fill.
   * Returns false on Redis error (fail open — don't block fills).
   */
  async isPending(orderHash: string): Promise<boolean> {
    try {
      const key = `${NS}:pending:${orderHash}`;
      const response = await fetch(
        `${this.baseUrl}/exists/${encodeURIComponent(key)}`,
        { headers: { Authorization: `Bearer ${this.token}` } },
      );
      if (!response.ok) return false;
      const data = await response.json() as { result: number };
      return data.result === 1;
    } catch {
      return false;
    }
  }

  /**
   * Extend a lock's TTL (useful for long-running operations).
   */
  async extendLock(lockKey: string, lockValue: string, ttlSeconds: number): Promise<boolean> {
    try {
      const key = `${NS}:lock:${lockKey}`;
      
      // Lua script for atomic check-and-extend
      const luaScript = `
        if redis.call("GET", KEYS[1]) == ARGV[1] then
          return redis.call("EXPIRE", KEYS[1], ARGV[2])
        else
          return 0
        end
      `;
      
      const response = await fetch(`${this.baseUrl}/eval`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          script: luaScript,
          keys: [key],
          args: [lockValue, ttlSeconds.toString()],
        }),
      });

      if (!response.ok) {
        console.warn(`[cache] Lock extension failed for ${lockKey}: ${response.status}`);
        return false;
      }

      const data = await response.json() as { result: number };
      return data.result === 1;
    } catch (err) {
      console.error(`[cache] Lock extension error for ${lockKey}:`, err);
      return false;
    }
  }
}

/**
 * Cache key builders for different endpoint types.
 */
export const CacheKeys = {
  bestListing: (chainId: string, collection: string) => 
    `${CACHE_CONFIGS.bestListing.keyPrefix}:${chainId}:${collection}`,
  
  collectionStats: (chainId: string, collection: string) =>
    `${CACHE_CONFIGS.collectionStats.keyPrefix}:${chainId}:${collection}`,
  
  order: (hash: string) =>
    `${CACHE_CONFIGS.order.keyPrefix}:${hash}`,
  
  ordersList: (chainId: string, collection: string, filtersHash: string) =>
    `${CACHE_CONFIGS.ordersList.keyPrefix}:${chainId}:${collection}:${filtersHash}`,

  // Invalidation patterns
  allBestListings: (chainId: string, collection: string) =>
    `${CACHE_CONFIGS.bestListing.keyPrefix}:${chainId}:${collection}*`,
  
  allCollectionStats: (chainId: string, collection: string) =>
    `${CACHE_CONFIGS.collectionStats.keyPrefix}:${chainId}:${collection}*`,
  
  allOrdersLists: (chainId: string, collection: string) =>
    `${CACHE_CONFIGS.ordersList.keyPrefix}:${chainId}:${collection}:*`,
};

/**
 * Get cache configuration for a specific cache type.
 */
export function getCacheConfig(type: keyof typeof CACHE_CONFIGS): CacheConfig {
  return CACHE_CONFIGS[type];
}

/**
 * Create a stable hash of query parameters for cache key generation.
 * Uses FNV-1a 32-bit which has better avalanche properties than djb2
 * and negligible collision rate for the short strings we produce here.
 * Params are sorted so order doesn't create duplicate cache entries.
 */
export function hashQueryParams(params: URLSearchParams): string {
  const sorted = Array.from(params.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");

  // FNV-1a 32-bit
  let hash = 0x811c9dc5;
  for (let i = 0; i < sorted.length; i++) {
    hash ^= sorted.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  // Unsigned 32-bit → base36 string
  return (hash >>> 0).toString(36);
}
