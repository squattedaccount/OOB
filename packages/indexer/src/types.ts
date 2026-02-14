/**
 * OOB Indexer — Type Definitions
 */

export interface Env {
  DATABASE_URL: string;
  WEBHOOK_SECRET?: string;
  ALCHEMY_SIGNING_KEY?: string;

  // Max orders to check for staleness per cron run
  STALE_CHECK_LIMIT?: string;

  // RPC URLs per chain (for ownership checks)
  RPC_URL_ETHEREUM?: string;
  RPC_URL_BASE?: string;
  RPC_URL_HYPERLIQUID?: string;
  RPC_URL_RONIN?: string;
  RPC_URL_ABSTRACT?: string;
  RPC_URL_BASE_SEPOLIA?: string;
  RPC_URL_RONIN_TESTNET?: string;
}

export interface SeaportLifecycleEvent {
  type: "fulfilled" | "cancelled" | "counter_incremented";
  orderHash?: string;
  offerer?: string;
  newCounter?: string;
  txHash: string;
  chainId: number;
  blockNumber?: number;
  blockTimestamp?: string;
}

export interface WebhookLogEntry {
  address: string;
  topics: string[];
  data: string;
  transactionHash: string;
  blockNumber: string | number;
  blockTimestamp?: string;
  chainId?: number;
}

export interface ProcessingResult {
  received: number;
  processed: number;
  fulfilled: number;
  cancelled: number;
  counterIncremented: number;
  errors: number;
}

export interface CronResult {
  expired: number;
  staleDetected: number;
  errors: string[];
}
