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
  // Upstash Redis for hot cache
  UPSTASH_REDIS_REST_URL?: string;
  UPSTASH_REDIS_REST_TOKEN?: string;
  // Cloudflare Queue for write-behind order ingestion (optional)
  ORDER_INGEST_QUEUE?: Queue<OrderIngestMessage>;
  // RPC URLs for on-chain validation (ownerOf check in fill-tx)
  RPC_URL_ETHEREUM?: string;
  RPC_URL_BASE?: string;
  RPC_URL_BASE_SEPOLIA?: string;
  RPC_URL_HYPERLIQUID?: string;
  RPC_URL_RONIN?: string;
  RPC_URL_RONIN_TESTNET?: string;
  RPC_URL_ABSTRACT?: string;
}

export interface OrderIngestMessage {
  chainId: number;
  order: any;
  signature: string;
  orderHash: string;
  orderType: string;
  nftContract: string;
  tokenId: string;
  tokenStandard: string;
  priceWei: string;
  currency: string;
  offerer: string;
  zone: string;
  startTime: number;
  endTime: number;
  feeRecipient: string;
  feeBps: number;
  royaltyRecipient: string | null;
  royaltyBps: number;
}

export interface RouteContext {
  request: Request;
  env: Env;
  url: URL;
  segments: string[];
  params: URLSearchParams;
}
