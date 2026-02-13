export interface Env {
  DATABASE_URL: string;
  API_ADMIN_TOKEN?: string;
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
