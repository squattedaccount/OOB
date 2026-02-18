export interface Env {
  DATABASE_URL: string;
  POOL_DATABASE_URL?: string; // Neon pooled endpoint (add -pooler to endpoint ID in Neon dashboard)
  API_ADMIN_TOKEN?: string;
  // Protocol fee enforcement (OOB takes this on every order)
  PROTOCOL_FEE_RECIPIENT: string;  // Required — OOB treasury address
  PROTOCOL_FEE_BPS?: string;       // Protocol fee in basis points (default: 50 = 0.5%)
  // Comma-separated list of valid API keys for registered rate-limit tier
  API_KEYS?: string;
  // Rate limit config (per minute)
  RATE_LIMIT_PUBLIC_READS?: string;
  RATE_LIMIT_PUBLIC_WRITES?: string;
  RATE_LIMIT_REGISTERED_READS?: string;
  RATE_LIMIT_REGISTERED_WRITES?: string;
  // KV for rate limiting
  OOB_RATE_LIMIT?: KVNamespace;
  // Durable Object for WebSocket streams
  ORDER_STREAM?: DurableObjectNamespace;
  // Internal secret for DO broadcast auth (set via wrangler secret put)
  INTERNAL_SECRET?: string;
  // Number of DO shards per room (default 1). Increase for high-traffic collections.
  // Each shard is a separate DO instance; broadcaster fans out to all shards.
  DO_SHARD_COUNT?: string;
}

export interface RouteContext {
  request: Request;
  env: Env;
  url: URL;
  segments: string[];
  params: URLSearchParams;
}
