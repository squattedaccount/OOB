import { neon } from "@neondatabase/serverless";
import type { NeonQueryFunction } from "@neondatabase/serverless";

export type SqlClient = NeonQueryFunction<false, false>;

export function getSqlClient(databaseUrl: string): SqlClient {
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is not configured");
  }
  return neon(databaseUrl);
}

/**
 * Returns a SQL client using the Neon connection pooler endpoint when available.
 * Falls back to the direct connection string if POOL_DATABASE_URL is not set.
 *
 * Use this for all API request handlers. The pooler (PgBouncer) reuses
 * server-side connections across Cloudflare Worker invocations, significantly
 * reducing Neon CU consumption at steady low load.
 *
 * Do NOT use this for migrations — CONCURRENTLY index creation requires a
 * direct (non-pooled) connection.
 */
export function getPooledSqlClient(env: { DATABASE_URL: string; POOL_DATABASE_URL?: string }): SqlClient {
  const url = env.POOL_DATABASE_URL || env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL is not configured");
  }
  return neon(url);
}
