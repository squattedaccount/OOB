/**
 * OpenOrderBook — main SDK client.
 * Combines the API client (off-chain reads/writes) with the Seaport client (on-chain).
 */

import type {
  Address,
  Hex,
  PublicClient,
  WalletClient,
} from "viem";
import { ApiClient } from "./api.js";
import { SeaportClient } from "./seaport.js";
import type {
  OobConfig,
  OobOrder,
  GetOrdersParams,
  GetBestOrderParams,
  CreateListingParams,
  CreateOfferParams,
  FillOrderParams,
  OrdersResponse,
  SingleOrderResponse,
  SubmitOrderResponse,
  CollectionStatsResponse,
  SubscribeParams,
  OobEvent,
  SeaportOrderComponents,
} from "./types.js";
import { DEFAULT_API_URL, DEFAULT_FEE_BPS, DEFAULT_FEE_RECIPIENT } from "./types.js";

// ─── Input Validation ─────────────────────────────────────────────────────

const ETH_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

function validateAddress(value: string, label: string): void {
  if (!ETH_ADDRESS_RE.test(value)) {
    throw new Error(`Invalid ${label}: "${value}" is not a valid Ethereum address`);
  }
}

function validatePositiveBigInt(value: string | bigint, label: string): void {
  try {
    const n = BigInt(value);
    if (n <= 0n) throw new Error(`${label} must be greater than zero`);
  } catch (e: any) {
    if (e.message?.includes("must be greater")) throw e;
    throw new Error(`Invalid ${label}: cannot parse "${value}" as a number`);
  }
}

function validateBps(value: number | undefined, label: string): void {
  if (value === undefined || value === 0) return;
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0 || value > 10000) {
    throw new Error(`Invalid ${label}: must be an integer between 0 and 10000 (got ${value})`);
  }
}

export class OpenOrderBook {
  readonly config: Required<OobConfig>;
  readonly api: ApiClient;
  readonly seaport: SeaportClient;

  private walletClient?: WalletClient;
  private publicClient?: PublicClient;

  constructor(config: OobConfig) {
    validateBps(config.feeBps, "feeBps");
    if ((config.feeBps ?? DEFAULT_FEE_BPS) > 0 && !(config.feeRecipient ?? DEFAULT_FEE_RECIPIENT)) {
      throw new Error("Invalid config: feeRecipient is required when feeBps > 0");
    }
    this.config = {
      chainId: config.chainId,
      apiUrl: config.apiUrl ?? DEFAULT_API_URL,
      apiKey: config.apiKey ?? "",
      feeBps: config.feeBps ?? DEFAULT_FEE_BPS,
      feeRecipient: config.feeRecipient ?? DEFAULT_FEE_RECIPIENT,
    };

    this.api = new ApiClient(this.config);
    this.seaport = new SeaportClient(this.config);
  }

  // ─── Connection ─────────────────────────────────────────────────────────

  /**
   * Connect a wallet for signing transactions and orders.
   * Also requires a public client for on-chain reads.
   */
  connect(walletClient: WalletClient, publicClient: PublicClient): this {
    this.walletClient = walletClient;
    this.publicClient = publicClient;
    return this;
  }

  private requireWallet(): { wallet: WalletClient; public: PublicClient } {
    if (!this.walletClient || !this.publicClient) {
      throw new Error(
        "Wallet not connected. Call oob.connect(walletClient, publicClient) first.",
      );
    }
    return { wallet: this.walletClient, public: this.publicClient };
  }

  private requirePublic(): PublicClient {
    if (!this.publicClient) {
      throw new Error(
        "Public client not connected. Call oob.connect(walletClient, publicClient) first.",
      );
    }
    return this.publicClient;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // READ METHODS (no wallet needed, API only)
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Get orders from the order book.
   *
   * @example
   * const { orders, total } = await oob.getOrders({
   *   collection: '0x...',
   *   type: 'listing',
   *   sortBy: 'price_asc',
   * });
   */
  async getOrders(params?: GetOrdersParams): Promise<OrdersResponse> {
    return this.api.getOrders(params);
  }

  /**
   * Get a single order by hash.
   */
  async getOrder(orderHash: string): Promise<OobOrder | null> {
    const res = await this.api.getOrder(orderHash);
    return res.order;
  }

  /**
   * Get the cheapest active listing for a token (or collection floor).
   *
   * @example
   * const listing = await oob.getBestListing({ collection: '0x...', tokenId: '42' });
   */
  async getBestListing(params: GetBestOrderParams): Promise<OobOrder | null> {
    const res = await this.api.getBestListing(params);
    return res.order;
  }

  /**
   * Get the highest active offer for a token (or collection).
   */
  async getBestOffer(params: GetBestOrderParams): Promise<OobOrder | null> {
    const res = await this.api.getBestOffer(params);
    return res.order;
  }

  /**
   * Get all active listings for a collection.
   * Convenience wrapper around getOrders().
   */
  async getListings(
    collectionOrParams: string | { collection: string; tokenId?: string; limit?: number; offset?: number },
    opts?: { tokenId?: string; limit?: number; offset?: number },
  ): Promise<OrdersResponse> {
    const params = typeof collectionOrParams === "string"
      ? { collection: collectionOrParams, ...opts }
      : collectionOrParams;
    return this.api.getOrders({
      ...params,
      type: "listing",
      status: "active",
      sortBy: "price_asc",
    });
  }

  /**
   * Get all active offers for a collection or token.
   */
  async getOffers(
    collectionOrParams: string | { collection: string; tokenId?: string; limit?: number; offset?: number },
    opts?: { tokenId?: string; limit?: number; offset?: number },
  ): Promise<OrdersResponse> {
    const params = typeof collectionOrParams === "string"
      ? { collection: collectionOrParams, ...opts }
      : collectionOrParams;
    return this.api.getOrders({
      ...params,
      type: "offer",
      status: "active",
      sortBy: "price_desc",
    });
  }

  /**
   * Get collection-level stats (floor price, listing count, best offer, etc.)
   */
  async getCollectionStats(collection: string): Promise<CollectionStatsResponse> {
    return this.api.getCollectionStats(collection);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // WRITE METHODS (wallet required)
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Create a listing (sell an NFT).
   * Signs the order off-chain and submits to the API.
   *
   * @example
   * const result = await oob.createListing({
   *   collection: '0x...',
   *   tokenId: '42',
   *   priceWei: '1000000000000000000', // 1 ETH
   * });
   * console.log(result.orderHash);
   */
  async createListing(params: CreateListingParams): Promise<SubmitOrderResponse> {
    validateAddress(params.collection, "collection");
    validatePositiveBigInt(params.priceWei, "priceWei");
    if (params.currency) validateAddress(params.currency, "currency");
    if (params.royaltyRecipient) validateAddress(params.royaltyRecipient, "royaltyRecipient");
    validateBps(params.royaltyBps, "royaltyBps");

    const { wallet, public: pub } = this.requireWallet();

    // Check approval first
    const isApproved = await this.seaport.isApprovedForAll(
      params.collection as Address,
      wallet.account!.address as Address,
      pub,
    );

    if (!isApproved) {
      throw new NeedsApprovalError(
        "collection",
        params.collection,
        "NFT collection is not approved for Seaport. Call oob.approveCollection() first.",
      );
    }

    // Fetch current protocol fee from API (cached 5 min)
    const protocolConfig = await this.api.getProtocolConfig();

    const { order, signature } = await this.seaport.createListing(params, wallet, pub, protocolConfig);
    return this.api.submitOrder(order, signature);
  }

  /**
   * Create an offer (bid on an NFT or collection).
   * Signs the order off-chain and submits to the API.
   *
   * @example
   * const result = await oob.createOffer({
   *   collection: '0x...',
   *   tokenId: '42',
   *   amountWei: '500000000000000000', // 0.5 WETH
   *   currency: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', // WETH
   * });
   */
  async createOffer(params: CreateOfferParams): Promise<SubmitOrderResponse> {
    validateAddress(params.collection, "collection");
    validateAddress(params.currency, "currency");
    validatePositiveBigInt(params.amountWei, "amountWei");
    if (params.royaltyRecipient) validateAddress(params.royaltyRecipient, "royaltyRecipient");
    validateBps(params.royaltyBps, "royaltyBps");

    const { wallet, public: pub } = this.requireWallet();

    // Check ERC20 readiness
    const readiness = await this.seaport.checkErc20Readiness(
      params.currency as Address,
      wallet.account!.address as Address,
      BigInt(params.amountWei),
      pub,
    );

    if (!readiness.hasBalance) {
      throw new InsufficientBalanceError(
        params.currency,
        readiness.balance,
        BigInt(params.amountWei),
      );
    }

    if (!readiness.hasAllowance) {
      throw new NeedsApprovalError(
        "erc20",
        params.currency,
        "ERC20 token is not approved for Seaport. Call oob.approveErc20() first.",
      );
    }

    // Fetch current protocol fee from API (cached 5 min)
    const protocolConfig = await this.api.getProtocolConfig();

    const { order, signature } = await this.seaport.createOffer(params, wallet, pub, protocolConfig);
    return this.api.submitOrder(order, signature);
  }

  /**
   * Fill (buy/accept) an order on-chain.
   * For listings: buyer pays ETH/ERC20 and receives NFT.
   * For offers: seller sends NFT and receives ERC20.
   *
   * @example
   * // Simple buy
   * const txHash = await oob.fillOrder('0xOrderHash...');
   *
   * // Buy with custom tip (for third-party marketplaces)
   * const txHash = await oob.fillOrder('0xOrderHash...', {
   *   tip: { recipient: '0xYourFeeWallet', basisPoints: 100 }
   * });
   */
  async fillOrder(orderHash: string, params?: FillOrderParams): Promise<Hex> {
    const { wallet, public: pub } = this.requireWallet();

    const order = await this.getOrder(orderHash);
    if (!order) throw new Error(`Order ${orderHash} not found`);
    if (order.status !== "active") throw new Error(`Order is ${order.status}, not active`);

    const filler = wallet.account!.address as Address;

    if (order.orderType === "offer") {
      // Seller accepting an offer: only needs NFT approval.
      // Fee consideration items are funded from the offerer's ERC20 offer amount
      // by Seaport during execution — the seller does not need ERC20 allowance.
      const nftApproved = await this.seaport.isApprovedForAll(
        order.nftContract as Address,
        filler,
        pub,
      );
      if (!nftApproved) {
        throw new NeedsApprovalError(
          "collection",
          order.nftContract,
          "NFT collection is not approved for Seaport. Call oob.approveCollection() first.",
        );
      }
    } else {
      // Buyer filling a listing: check they can pay
      const isNative = order.currency === "0x0000000000000000000000000000000000000000";
      if (!isNative) {
        const readiness = await this.seaport.checkErc20Readiness(
          order.currency as Address,
          filler,
          BigInt(order.priceWei),
          pub,
        );
        if (!readiness.hasBalance) {
          throw new InsufficientBalanceError(
            order.currency,
            readiness.balance,
            BigInt(order.priceWei),
          );
        }
        if (!readiness.hasAllowance) {
          throw new NeedsApprovalError(
            "erc20",
            order.currency,
            "ERC20 token is not approved for Seaport. Call oob.approveErc20() first.",
          );
        }
      }
    }

    return this.seaport.fillOrder(order, wallet, pub, params);
  }

  /**
   * Cancel an order: sign cancel message for API + cancel on-chain.
   * The API is notified immediately via signature so the order is marked
   * cancelled off-chain without waiting for the indexer webhook.
   */
  async cancelOrder(orderHash: string): Promise<{ txHash: Hex; apiStatus: string }> {
    const { wallet } = this.requireWallet();
    const account = wallet.account;
    if (!account) throw new Error("WalletClient must have an account");

    const order = await this.getOrder(orderHash);
    if (!order) throw new Error(`Order ${orderHash} not found`);

    // 1. Sign cancel message for the API (EIP-191 personal_sign)
    const cancelMessage = `cancel:${orderHash}`;
    const cancelSig = await wallet.signMessage({
      message: cancelMessage,
      account,
    });

    // 2. Notify API immediately (off-chain cancel)
    const apiResult = await this.api.cancelOrder(orderHash, cancelSig);

    // 3. Cancel on-chain via Seaport (so order can't be filled even if API is down)
    const txHash = await this.seaport.cancelOrders([order.orderJson], wallet);

    return { txHash, apiStatus: apiResult.status };
  }

  /**
   * Submit a pre-signed order to the API.
   * Useful for bots that construct and sign orders themselves.
   */
  async submitOrder(
    order: SeaportOrderComponents,
    signature: string,
  ): Promise<SubmitOrderResponse> {
    return this.api.submitOrder(order, signature as Hex);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // UTILITY METHODS
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Check if Seaport is approved to transfer NFTs from a collection for a given wallet.
   */
  async isApproved(collection: string, owner?: string): Promise<boolean> {
    const pub = this.requirePublic();
    const ownerAddr = owner
      ? (owner as Address)
      : this.walletClient?.account?.address;
    if (!ownerAddr) throw new Error("Provide an owner address or connect a wallet");

    return this.seaport.isApprovedForAll(
      collection as Address,
      ownerAddr as Address,
      pub,
    );
  }

  /**
   * Check if a wallet is ready to make an offer (has balance + allowance).
   */
  async isReadyToOffer(
    currency: string,
    amountWei: string | bigint,
    owner?: string,
  ): Promise<{
    hasBalance: boolean;
    hasAllowance: boolean;
    needsApproval: boolean;
    balance: bigint;
    allowance: bigint;
  }> {
    const pub = this.requirePublic();
    const ownerAddr = owner
      ? (owner as Address)
      : this.walletClient?.account?.address;
    if (!ownerAddr) throw new Error("Provide an owner address or connect a wallet");

    return this.seaport.checkErc20Readiness(
      currency as Address,
      ownerAddr as Address,
      BigInt(amountWei),
      pub,
    );
  }

  /**
   * Approve Seaport to transfer NFTs from a collection.
   * Only needed once per collection per wallet.
   */
  async approveCollection(collection: string): Promise<Hex> {
    const { wallet } = this.requireWallet();
    return this.seaport.approveNftCollection(collection as Address, wallet);
  }

  /**
   * Approve Seaport to spend ERC20 tokens (e.g. WETH for offers).
   * Pass MaxUint256 for unlimited approval.
   */
  async approveErc20(
    token: string,
    amount: bigint = 2n ** 256n - 1n,
  ): Promise<Hex> {
    const { wallet } = this.requireWallet();
    return this.seaport.approveErc20(token as Address, amount, wallet);
  }

  /**
   * Get the on-chain status of a Seaport order.
   */
  async getOnChainStatus(orderHash: string): Promise<{
    isValidated: boolean;
    isCancelled: boolean;
    totalFilled: bigint;
    totalSize: bigint;
  }> {
    const pub = this.requirePublic();
    return this.seaport.getOrderStatus(orderHash as Hex, pub);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // REAL-TIME SUBSCRIPTIONS (WebSocket)
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Subscribe to real-time order events via WebSocket.
   * Returns an unsubscribe function.
   *
   * @example
   * const unsub = oob.subscribe(
   *   { collection: '0x...', events: ['new_listing', 'sale'] },
   *   (event) => console.log(event.type, event.order.orderHash),
   * );
   * // Later: unsub();
   */
  subscribe(
    params: SubscribeParams,
    callback: (event: OobEvent) => void,
  ): () => void {
    const wsUrl = this.config.apiUrl
      .replace("https://", "wss://")
      .replace("http://", "ws://");

    const qs = new URLSearchParams();
    qs.set("chainId", String(this.config.chainId));
    if (params.collection) qs.set("collection", params.collection);
    if (params.events?.length) qs.set("events", params.events.join(","));

    const ws = new WebSocket(`${wsUrl}/v1/stream?${qs.toString()}`);

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data as string) as OobEvent;
        callback(data);
      } catch {
        // ignore malformed messages
      }
    };

    ws.onerror = (err) => {
      console.error("[oob-sdk] WebSocket error:", err);
    };

    // Return unsubscribe function
    return () => {
      ws.close();
    };
  }
}

// ─── Custom Errors ──────────────────────────────────────────────────────────

export class NeedsApprovalError extends Error {
  constructor(
    public readonly approvalType: "collection" | "erc20",
    public readonly tokenAddress: string,
    message: string,
  ) {
    super(message);
    this.name = "NeedsApprovalError";
  }
}

export class InsufficientBalanceError extends Error {
  constructor(
    public readonly tokenAddress: string,
    public readonly balance: bigint,
    public readonly required: bigint,
  ) {
    super(
      `Insufficient balance: have ${balance}, need ${required} of ${tokenAddress}`,
    );
    this.name = "InsufficientBalanceError";
  }
}
