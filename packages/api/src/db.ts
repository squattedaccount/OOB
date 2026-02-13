import { neon, neonConfig } from "@neondatabase/serverless";
import type { NeonQueryFunction } from "@neondatabase/serverless";

neonConfig.fetchConnectionCache = true;

export type SqlClient = NeonQueryFunction<false, false>;

export function getSqlClient(databaseUrl: string): SqlClient {
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is not configured");
  }
  return neon(databaseUrl);
}
