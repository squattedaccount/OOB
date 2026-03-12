import type { CliErrorCode } from "./errors.js";

export type OutputFormat = "json" | "jsonl" | "text" | "toon" | "table";

export type OrderStatus = "active" | "filled" | "cancelled" | "expired" | "stale";
export type OrderType = "listing" | "offer";
export type SortBy = "created_at_desc" | "price_asc" | "price_desc";

export interface OobOrder {
  orderHash: string;
  chainId: number;
  orderType: OrderType;
  offerer: string;
  nftContract: string;
  tokenId: string;
  tokenStandard: "ERC721" | "ERC1155";
  priceWei: string;
  currency: string;
  protocolFeeRecipient: string;
  protocolFeeBps: number;
  royaltyRecipient: string | null;
  royaltyBps: number;
  startTime: number;
  endTime: number;
  status: OrderStatus;
  createdAt: string;
  filledTxHash: string | null;
  filledAt: string | null;
  cancelledTxHash: string | null;
  cancelledAt: string | null;
  orderJson: unknown;
  signature: string;
}

export interface OrdersResponse {
  orders: OobOrder[];
  total: number;
}

export interface SingleOrderResponse {
  order: OobOrder | null;
}

export interface CollectionStatsResponse {
  collection: string;
  chainId: number;
  listingCount: number;
  floorPriceWei: string | null;
  offerCount: number;
  bestOfferWei: string | null;
}

export interface ProtocolConfigResponse {
  protocolFeeBps: number;
  protocolFeeRecipient: string;
}

export interface FillTxResponse {
  to: string;
  data: string;
  value: string;
  chainId: number;
  orderHash: string;
  orderType: string;
  nftContract: string;
  tokenId: string;
  tokenStandard: string;
  offerer: string;
  currency: string;
  currencySymbol: string;
  currencyDecimals: number;
  priceWei: string;
  priceDecimal: string;
  expiresAt: number;
  tipBps?: number;
  tipRecipient?: string;
  warning?: string;
}

export interface ActivityEvent {
  id: number;
  orderHash: string;
  chainId: number;
  eventType: string;
  fromAddress: string;
  toAddress: string | null;
  nftContract: string;
  tokenId: string;
  priceWei: string;
  currency: string;
  currencySymbol: string;
  currencyDecimals: number;
  priceDecimal: string;
  txHash: string | null;
  createdAt: string;
}

export interface ActivityResponse {
  activity: ActivityEvent[];
  total: number;
}

export interface ActivityQueryParams {
  orderHash?: string;
  collection?: string;
  tokenId?: string;
  eventType?: string;
  address?: string;
  limit?: number;
  offset?: number;
}

export interface GetOrdersParams {
  collection?: string;
  tokenId?: string;
  type?: OrderType;
  offerer?: string;
  status?: OrderStatus;
  sortBy?: SortBy;
  limit?: number;
  offset?: number;
}

export interface GetBestOrderParams {
  collection: string;
  tokenId?: string;
}

export interface RuntimeConfig {
  apiKey?: string;
  apiUrl: string;
  chainId: number;
  dryRun: boolean;
  env: string;
  field?: string;
  humanPrices: boolean;
  intervalMs: number;
  maxLines?: number;
  output: OutputFormat;
  privateKey?: string;
  raw: boolean;
  retries: number;
  retryDelayMs: number;
  rpcUrl?: string;
  timeoutMs: number;
  verbose: boolean;
  watch: boolean;
  yes: boolean;
}

export interface CommandOptions {
  apiKey?: unknown;
  apiUrl?: unknown;
  chainId?: unknown;
  dryRun?: unknown;
  env?: unknown;
  field?: unknown;
  humanPrices?: unknown;
  interval?: unknown;
  json?: unknown;
  jsonl?: unknown;
  maxLines?: unknown;
  output?: unknown;
  privateKey?: unknown;
  raw?: unknown;
  retries?: unknown;
  retryDelay?: unknown;
  rpcUrl?: unknown;
  table?: unknown;
  text?: unknown;
  toon?: unknown;
  timeout?: unknown;
  verbose?: unknown;
  watch?: unknown;
  yes?: unknown;
}

export interface BatchRunOptions {
  file?: string;
  stdin?: boolean;
}

export interface BatchRequest {
  args?: Record<string, unknown>;
  command: string;
}

export interface BatchResult {
  command: string;
  data?: unknown;
  error?: {
    code: CliErrorCode;
    exitCode: number;
    message: string;
    name: string;
    status?: number;
  };
  ok: boolean;
}

export interface MarketTargetOptions {
  collection: string;
  tokenId?: string;
}

export interface TokenSummaryData {
  bestListing: OobOrder | null;
  bestOffer: OobOrder | null;
  collection: string;
  offerCount: number;
  tokenId: string;
  totalOrders: number;
}

export interface MarketSnapshotData {
  bestListing: OobOrder | null;
  bestOffer: OobOrder | null;
  collection: string;
  floorPriceWei: string | null;
  listingCount: number;
  offerCount: number;
  spreadWei: string | null;
}

export interface ConfigDoctorData {
  apiKeyConfigured: boolean;
  apiReachable: boolean;
  apiUrl: string;
  chainId: number;
  env: string;
  nodeVersion: string;
  output: OutputFormat;
}

export interface OrdersListOptions {
  collection?: string;
  limit?: string;
  offerer?: string;
  offset?: string;
  sortBy?: string;
  status?: string;
  tokenId?: string;
  type?: string;
}

export interface BestOrderOptions {
  collection: string;
  tokenId?: string;
}

export interface DescribeSchema {
  name: string;
  description: string;
  arguments: Array<{
    name: string;
    description: string;
    required: boolean;
    type: string;
  }>;
  options: Array<{
    name: string;
    flags: string;
    description: string;
    required: boolean;
  }>;
  outputFields: string[];
}
