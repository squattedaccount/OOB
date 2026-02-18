/**
 * HTTP API client for the Open Order Book backend.
 * Handles all REST communication. No wallet/signing logic here.
 */

import type {
  OobConfig,
  ProtocolConfig,
  GetOrdersParams,
  GetBestOrderParams,
  OrdersResponse,
  SingleOrderResponse,
  SubmitOrderResponse,
  CollectionStatsResponse,
  SeaportOrderComponents,
} from "./types.js";
import { DEFAULT_API_URL } from "./types.js";

export class ApiClient {
  private baseUrl: string;
  private chainId: number;
  private apiKey?: string;

  // Protocol config cache (TTL: 5 minutes)
  private _protocolConfig: ProtocolConfig | null = null;
  private _protocolConfigFetchedAt = 0;
  private static PROTOCOL_CONFIG_TTL = 5 * 60 * 1000; // 5 min

  constructor(config: OobConfig) {
    this.baseUrl = (config.apiUrl || DEFAULT_API_URL).replace(/\/$/, "");
    this.chainId = config.chainId;
    this.apiKey = config.apiKey;
  }

  // ─── Protocol Config ──────────────────────────────────────────────────

  /**
   * Fetch the current protocol fee config from the API.
   * Cached for 5 minutes to avoid excessive requests.
   */
  async getProtocolConfig(): Promise<ProtocolConfig> {
    const now = Date.now();
    if (this._protocolConfig && (now - this._protocolConfigFetchedAt) < ApiClient.PROTOCOL_CONFIG_TTL) {
      return this._protocolConfig;
    }
    const config = await this.get<ProtocolConfig>("/v1/config");
    this._protocolConfig = config;
    this._protocolConfigFetchedAt = now;
    return config;
  }

  // ─── Read Methods ───────────────────────────────────────────────────────

  async getOrders(params: GetOrdersParams = {}): Promise<OrdersResponse> {
    const qs = new URLSearchParams();
    qs.set("chainId", String(this.chainId));
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
    qs.set("chainId", String(this.chainId));
    qs.set("collection", params.collection);
    if (params.tokenId) qs.set("tokenId", params.tokenId);

    return this.get<SingleOrderResponse>(`/v1/orders/best-listing?${qs.toString()}`);
  }

  async getBestOffer(params: GetBestOrderParams): Promise<SingleOrderResponse> {
    const qs = new URLSearchParams();
    qs.set("chainId", String(this.chainId));
    qs.set("collection", params.collection);
    if (params.tokenId) qs.set("tokenId", params.tokenId);

    return this.get<SingleOrderResponse>(`/v1/orders/best-offer?${qs.toString()}`);
  }

  async getCollectionStats(collection: string): Promise<CollectionStatsResponse> {
    const qs = new URLSearchParams();
    qs.set("chainId", String(this.chainId));

    return this.get<CollectionStatsResponse>(
      `/v1/collections/${collection.toLowerCase()}/stats?${qs.toString()}`,
    );
  }

  // ─── Write Methods ──────────────────────────────────────────────────────

  async submitOrder(
    order: SeaportOrderComponents,
    signature: string,
  ): Promise<SubmitOrderResponse> {
    return this.post<SubmitOrderResponse>("/v1/orders", {
      chainId: this.chainId,
      order,
      signature,
    });
  }

  async cancelOrder(
    orderHash: string,
    signature: string,
  ): Promise<{ orderHash: string; status: string }> {
    return this.del<{ orderHash: string; status: string }>(
      `/v1/orders/${orderHash}`,
      { signature },
    );
  }

  // ─── HTTP Helpers ───────────────────────────────────────────────────────

  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.apiKey) {
      h["X-API-Key"] = this.apiKey;
    }
    return h;
  }

  private static MAX_RETRIES = 3;
  private static RETRY_BASE_MS = 500;

  /**
   * Fetch with exponential backoff retry for 429 and 5xx errors.
   */
  private async fetchWithRetry(url: string, init: RequestInit): Promise<Response> {
    let lastError: Error | null = null;
    for (let attempt = 0; attempt <= ApiClient.MAX_RETRIES; attempt++) {
      try {
        const res = await fetch(url, init);
        if (res.status === 429 || (res.status >= 500 && attempt < ApiClient.MAX_RETRIES)) {
          const delay = ApiClient.RETRY_BASE_MS * Math.pow(2, attempt);
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
        return res;
      } catch (err) {
        lastError = err as Error;
        if (attempt < ApiClient.MAX_RETRIES) {
          const delay = ApiClient.RETRY_BASE_MS * Math.pow(2, attempt);
          await new Promise((r) => setTimeout(r, delay));
        }
      }
    }
    throw lastError ?? new Error("Request failed after retries");
  }

  private async get<T>(path: string): Promise<T> {
    const res = await this.fetchWithRetry(`${this.baseUrl}${path}`, {
      method: "GET",
      headers: this.headers(),
    });
    return this.handleResponse<T>(res);
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const res = await this.fetchWithRetry(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
    });
    return this.handleResponse<T>(res);
  }

  private async del<T>(path: string, body?: unknown): Promise<T> {
    const res = await this.fetchWithRetry(`${this.baseUrl}${path}`, {
      method: "DELETE",
      headers: this.headers(),
      body: body ? JSON.stringify(body) : undefined,
    });
    return this.handleResponse<T>(res);
  }

  private async handleResponse<T>(res: Response): Promise<T> {
    if (!res.ok) {
      let message = `API error ${res.status}`;
      try {
        const body = await res.json() as { error?: string };
        if (body.error) message = body.error;
      } catch {
        // ignore parse errors
      }
      throw new OobApiError(res.status, message);
    }
    return res.json() as Promise<T>;
  }
}

export class OobApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "OobApiError";
  }
}
