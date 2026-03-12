import { getJson } from "./network.js";
import type {
  ActivityQueryParams,
  ActivityResponse,
  CollectionStatsResponse,
  FillTxResponse,
  GetBestOrderParams,
  GetOrdersParams,
  OrdersResponse,
  ProtocolConfigResponse,
  RuntimeConfig,
  SingleOrderResponse,
} from "./types.js";

export class CliApiClient {
  constructor(private readonly config: RuntimeConfig) {}

  private baseUrl(): string {
    return this.config.apiUrl.replace(/\/$/, "");
  }

  private async get<T>(path: string): Promise<T> {
    if (this.config.verbose) {
      process.stderr.write(`[verbose] GET ${this.baseUrl()}${path}\n`);
    }
    const result = await getJson<T>({
      apiKey: this.config.apiKey,
      apiUrl: this.baseUrl(),
      retries: this.config.retries,
      retryDelayMs: this.config.retryDelayMs,
      timeoutMs: this.config.timeoutMs,
    }, path);
    if (this.config.verbose) {
      process.stderr.write(`[verbose] OK ${path}\n`);
    }
    return result;
  }

  async getProtocolConfig(): Promise<ProtocolConfigResponse> {
    return this.get<ProtocolConfigResponse>("/v1/config");
  }

  async getOrders(params: GetOrdersParams): Promise<OrdersResponse> {
    const qs = new URLSearchParams();
    qs.set("chainId", String(this.config.chainId));
    if (params.collection) qs.set("collection", params.collection);
    if (params.tokenId) qs.set("tokenId", params.tokenId);
    if (params.type) qs.set("type", params.type);
    if (params.offerer) qs.set("offerer", params.offerer);
    if (params.status) qs.set("status", params.status);
    if (params.sortBy) qs.set("sortBy", params.sortBy);
    if (params.limit != null) qs.set("limit", String(params.limit));
    if (params.offset != null) qs.set("offset", String(params.offset));
    return this.get<OrdersResponse>(`/v1/orders?${qs.toString()}`);
  }

  async getOrder(orderHash: string): Promise<SingleOrderResponse> {
    return this.get<SingleOrderResponse>(`/v1/orders/${orderHash}`);
  }

  async getBestListing(params: GetBestOrderParams): Promise<SingleOrderResponse> {
    const qs = new URLSearchParams();
    qs.set("chainId", String(this.config.chainId));
    qs.set("collection", params.collection);
    if (params.tokenId) qs.set("tokenId", params.tokenId);
    return this.get<SingleOrderResponse>(`/v1/orders/best-listing?${qs.toString()}`);
  }

  async getBestOffer(params: GetBestOrderParams): Promise<SingleOrderResponse> {
    const qs = new URLSearchParams();
    qs.set("chainId", String(this.config.chainId));
    qs.set("collection", params.collection);
    if (params.tokenId) qs.set("tokenId", params.tokenId);
    return this.get<SingleOrderResponse>(`/v1/orders/best-offer?${qs.toString()}`);
  }

  async getCollectionStats(collection: string): Promise<CollectionStatsResponse> {
    const qs = new URLSearchParams();
    qs.set("chainId", String(this.config.chainId));
    return this.get<CollectionStatsResponse>(`/v1/collections/${collection.toLowerCase()}/stats?${qs.toString()}`);
  }

  async getFillTx(orderHash: string, buyer: string, options?: { validate?: boolean; tipRecipient?: string; tipBps?: number }): Promise<FillTxResponse> {
    const qs = new URLSearchParams();
    qs.set("buyer", buyer);
    if (options?.validate) qs.set("validate", "true");
    if (options?.tipRecipient && options?.tipBps) {
      qs.set("tipRecipient", options.tipRecipient);
      qs.set("tipBps", String(options.tipBps));
    }
    return this.get<FillTxResponse>(`/v1/orders/${orderHash}/fill-tx?${qs.toString()}`);
  }

  async getBestListingFillTx(params: GetBestOrderParams & { buyer: string; tipRecipient?: string; tipBps?: number }): Promise<FillTxResponse> {
    const qs = new URLSearchParams();
    qs.set("chainId", String(this.config.chainId));
    qs.set("collection", params.collection);
    qs.set("buyer", params.buyer);
    if (params.tokenId) qs.set("tokenId", params.tokenId);
    if (params.tipRecipient && params.tipBps) {
      qs.set("tipRecipient", params.tipRecipient);
      qs.set("tipBps", String(params.tipBps));
    }
    return this.get<FillTxResponse>(`/v1/orders/best-listing/fill-tx?${qs.toString()}`);
  }

  async getOrderActivity(orderHash: string): Promise<ActivityResponse> {
    return this.get<ActivityResponse>(`/v1/orders/${orderHash}/activity`);
  }

  async getActivity(params: ActivityQueryParams): Promise<ActivityResponse> {
    const qs = new URLSearchParams();
    if (!params.orderHash) qs.set("chainId", String(this.config.chainId));
    if (params.orderHash) qs.set("orderHash", params.orderHash);
    if (params.collection) qs.set("collection", params.collection);
    if (params.tokenId) qs.set("tokenId", params.tokenId);
    if (params.eventType) qs.set("eventType", params.eventType);
    if (params.address) qs.set("address", params.address);
    if (params.limit != null) qs.set("limit", String(params.limit));
    if (params.offset != null) qs.set("offset", String(params.offset));
    return this.get<ActivityResponse>(`/v1/activity?${qs.toString()}`);
  }

  async getApproveTx(tokenAddress: string): Promise<{ to: string; data: string; value: string }> {
    return this.get<{ to: string; data: string; value: string }>(`/v1/erc20/${tokenAddress.toLowerCase()}/approve-tx`);
  }
}

export function createClient(config: RuntimeConfig): CliApiClient {
  return new CliApiClient(config);
}
