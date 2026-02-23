/**
 * Simple distributed locking for indexer coordination using Upstash Redis.
 */

import type { Env } from "./types.js";

export class IndexerLock {
  private baseUrl: string;
  private token: string;

  constructor(env: Env) {
    if (!env.UPSTASH_REDIS_REST_URL || !env.UPSTASH_REDIS_REST_TOKEN) {
      throw new Error("Upstash Redis not configured for indexer locks");
    }
    this.baseUrl = env.UPSTASH_REDIS_REST_URL;
    this.token = env.UPSTASH_REDIS_REST_TOKEN;
  }

  /**
   * Acquire a distributed lock.
   */
  async acquire(lockKey: string, ttlSeconds: number = 300): Promise<string | null> {
    try {
      const randomBytes = new Uint8Array(16);
      crypto.getRandomValues(randomBytes);
      const lockValue = Array.from(randomBytes, b => b.toString(16).padStart(2, "0")).join("");
      const key = `oob:lock:${lockKey}`;
      
      // Use SET with NX (only set if not exists) and EX (expiration)
      const response = await fetch(`${this.baseUrl}/set/${encodeURIComponent(key)}/${encodeURIComponent(lockValue)}/ex/${ttlSeconds}/nx`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.token}`,
        },
      });

      if (!response.ok) {
        console.warn(`[indexer-lock] Lock acquisition failed for ${lockKey}: ${response.status}`);
        return null;
      }

      const data = await response.json() as { result: string | null };
      // If result is "OK", we acquired the lock
      if (data.result === "OK") {
        return lockValue;
      }
      
      return null; // Lock already held by someone else
    } catch (err) {
      console.error(`[indexer-lock] Lock acquisition error for ${lockKey}:`, err);
      return null;
    }
  }

  /**
   * Release a distributed lock.
   */
  async release(lockKey: string, lockValue: string): Promise<boolean> {
    try {
      const key = `oob:lock:${lockKey}`;
      
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
        console.warn(`[indexer-lock] Lock release failed for ${lockKey}: ${response.status}`);
        return false;
      }

      const data = await response.json() as { result: number };
      return data.result === 1; // 1 means lock was released, 0 means we didn't own it
    } catch (err) {
      console.error(`[indexer-lock] Lock release error for ${lockKey}:`, err);
      return false;
    }
  }
}
