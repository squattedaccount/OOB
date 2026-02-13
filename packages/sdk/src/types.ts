/**
 * Core types for the Open Order Book SDK
 * Aligned with the existing nodz indexer API response shapes.
 */

// ─── Seaport Constants ──────────────────────────────────────────────────────

export const SEAPORT_ADDRESS = "0x0000000000000068F116a894984e2DB1123eB395" as const;
export const CONDUIT_CONTROLLER = "0x00000000F9490004C11Cef243f5400493c00Ad63" as const;

export const ItemType = {
  NATIVE: 0,
  ERC20: 1,
  ERC721: 2,
  ERC1155: 3,
  ERC721_WITH_CRITERIA: 4,
  ERC1155_WITH_CRITERIA: 5,
} as const;

export type ItemTypeValue = (typeof ItemType)[keyof typeof ItemType];

export const OrderType = {
  FULL_OPEN: 0,
  PARTIAL_OPEN: 1,
  FULL_RESTRICTED: 2,
  PARTIAL_RESTRICTED: 3,
} as const;

export type OrderTypeValue = (typeof OrderType)[keyof typeof OrderType];

// ─── Chain Config ───────────────────────────────────────────────────────────

export const SUPPORTED_CHAINS = {
  1: { name: "Ethereum", nativeSymbol: "ETH" },
  8453: { name: "Base", nativeSymbol: "ETH" },
  84532: { name: "Base Sepolia", nativeSymbol: "ETH" },
  999: { name: "Hyperliquid", nativeSymbol: "HYPE" },
  2020: { name: "Ronin", nativeSymbol: "RON" },
  2741: { name: "Abstract", nativeSymbol: "ETH" },
} as const;

export type SupportedChainId = keyof typeof SUPPORTED_CHAINS;

// ─── API Types ──────────────────────────────────────────────────────────────

/** An order as returned by the Open Order Book API */
export interface OobOrder {
  orderHash: string;
  chainId: number;
  orderType: "listing" | "offer";
  offerer: string;
  nftContract: string;
  tokenId: string;
  tokenStandard: "ERC721" | "ERC1155";
  priceWei: string;
  currency: string;
  feeRecipient: string;
  feeBps: number;
  startTime: number;
  endTime: number;
  status: OrderStatus;
  createdAt: string;
  filledTxHash: string | null;
  filledAt: string | null;
  cancelledTxHash: string | null;
  cancelledAt: string | null;
  /** Full Seaport OrderComponents — everything needed to fill on-chain */
  orderJson: SeaportOrderComponents;
  signature: string;
}

export type OrderStatus = "active" | "filled" | "cancelled" | "expired" | "stale";

// ─── Seaport Order Components (on-chain format) ────────────────────────────

export interface SeaportOfferItem {
  itemType: ItemTypeValue;
  token: string;
  identifierOrCriteria: string;
  startAmount: string;
  endAmount: string;
}

export interface SeaportConsiderationItem extends SeaportOfferItem {
  recipient: string;
}

export interface SeaportOrderComponents {
  offerer: string;
  zone: string;
  offer: SeaportOfferItem[];
  consideration: SeaportConsiderationItem[];
  orderType: OrderTypeValue;
  startTime: string;
  endTime: string;
  zoneHash: string;
  salt: string;
  conduitKey: string;
  counter: string;
}

// ─── SDK Config ─────────────────────────────────────────────────────────────

export interface OobConfig {
  /** Chain ID to operate on. Required. */
  chainId: number;
  /** API base URL. Defaults to https://api.openorderbook.xyz */
  apiUrl?: string;
  /** Optional API key for higher rate limits */
  apiKey?: string;
  /** Marketplace fee in basis points. Defaults to 50 (0.5%) */
  feeBps?: number;
  /** Fee recipient address. Defaults to OOB treasury. */
  feeRecipient?: string;
}

export const DEFAULT_API_URL = "https://api.openorderbook.xyz";
export const DEFAULT_FEE_BPS = 50;
// TODO: Replace with actual treasury address before mainnet
export const DEFAULT_FEE_RECIPIENT = "0x0000000000000000000000000000000000000001";
export const DEFAULT_LISTING_DURATION = 30 * 24 * 60 * 60; // 30 days
export const DEFAULT_OFFER_DURATION = 7 * 24 * 60 * 60; // 7 days

// ─── Query Params ───────────────────────────────────────────────────────────

export interface GetOrdersParams {
  collection?: string;
  tokenId?: string;
  type?: "listing" | "offer";
  offerer?: string;
  status?: OrderStatus;
  sortBy?: "created_at_desc" | "price_asc" | "price_desc";
  limit?: number;
  offset?: number;
}

export interface GetBestOrderParams {
  collection: string;
  tokenId?: string;
}

// ─── Write Params ───────────────────────────────────────────────────────────

export interface CreateListingParams {
  /** NFT contract address */
  collection: string;
  /** Token ID */
  tokenId: string;
  /** Price in wei (as string or bigint) */
  priceWei: string | bigint;
  /** Currency address. Defaults to native (0x0...0) */
  currency?: string;
  /** Duration in seconds. Defaults to 30 days. */
  duration?: number;
  /** Royalty basis points (e.g. 500 = 5%) */
  royaltyBps?: number;
  /** Royalty recipient address */
  royaltyRecipient?: string;
}

export interface CreateOfferParams {
  /** NFT contract address */
  collection: string;
  /** Token ID. Omit for collection-wide offer. */
  tokenId?: string;
  /** Offer amount in wei (as string or bigint) */
  amountWei: string | bigint;
  /** ERC20 currency address (typically WETH) */
  currency: string;
  /** Duration in seconds. Defaults to 7 days. */
  duration?: number;
  /** Royalty basis points */
  royaltyBps?: number;
  /** Royalty recipient address */
  royaltyRecipient?: string;
}

export interface FillOrderParams {
  /** Optional tip for the filling marketplace */
  tip?: {
    recipient: string;
    basisPoints: number;
  };
}

// ─── API Response Shapes ────────────────────────────────────────────────────

export interface OrdersResponse {
  orders: OobOrder[];
  total: number;
}

export interface SingleOrderResponse {
  order: OobOrder | null;
}

export interface SubmitOrderResponse {
  orderHash: string;
  status: string;
  duplicate?: boolean;
}

export interface CollectionStatsResponse {
  collection: string;
  chainId: number;
  listingCount: number;
  floorPriceWei: string | null;
  offerCount: number;
  bestOfferWei: string | null;
}

// ─── Events (for subscriptions) ─────────────────────────────────────────────

export type OobEventType = "new_listing" | "new_offer" | "sale" | "cancellation" | "price_change";

export interface OobEvent {
  type: OobEventType;
  order: OobOrder;
  timestamp: number;
}

export interface SubscribeParams {
  collection?: string;
  events?: OobEventType[];
}
