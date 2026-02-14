export interface Env {
  DATABASE_URL: string;
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
}

export interface RouteContext {
  request: Request;
  env: Env;
  url: URL;
  segments: string[];
  params: URLSearchParams;
}
