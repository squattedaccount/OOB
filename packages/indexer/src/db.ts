/**
 * OOB Indexer — Database Client
 *
 * Uses the same Neon Postgres database as the OOB API.
 */

import { neon, neonConfig } from "@neondatabase/serverless";
import type { NeonQueryFunction } from "@neondatabase/serverless";

neonConfig.fetchConnectionCache = true;

export type SqlClient = NeonQueryFunction<false, false>;

export function getSqlClient(databaseUrl: string): SqlClient {
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is not configured for oob-indexer");
  }
  return neon(databaseUrl);
}
