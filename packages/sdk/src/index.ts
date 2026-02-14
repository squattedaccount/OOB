/**
 * @oob/sdk — Open Order Book SDK
 *
 * Read, write, and fill Seaport v1.6 NFT orders from the Open Order Book.
 *
 * @example
 * ```ts
 * import { OpenOrderBook } from '@oob/sdk';
 *
 * const oob = new OpenOrderBook({ chainId: 8453 }); // Base
 *
 * // Read (no wallet needed)
 * const { orders } = await oob.getOrders({ collection: '0x...', type: 'listing' });
 * const best = await oob.getBestListing({ collection: '0x...', tokenId: '42' });
 *
 * // Write (connect wallet first)
 * oob.connect(walletClient, publicClient);
 * await oob.createListing({ collection: '0x...', tokenId: '42', priceWei: '1000000000000000000' });
 * await oob.fillOrder('0xOrderHash...');
 * await oob.fillOrder('0xOrderHash...', { tip: { recipient: '0x...', basisPoints: 100 } });
 * ```
 */

// Main client
export { OpenOrderBook, NeedsApprovalError, InsufficientBalanceError } from "./client.js";

// Sub-clients (for advanced usage)
export { ApiClient, OobApiError } from "./api.js";
export { SeaportClient } from "./seaport.js";

// Types
export type {
  OobConfig,
  ProtocolConfig,
  OobOrder,
  OrderStatus,
  SeaportOrderComponents,
  SeaportOfferItem,
  SeaportConsiderationItem,
  GetOrdersParams,
  GetBestOrderParams,
  CreateListingParams,
  CreateOfferParams,
  FillOrderParams,
  OrdersResponse,
  SingleOrderResponse,
  SubmitOrderResponse,
  CollectionStatsResponse,
  OobEventType,
  OobEvent,
  SubscribeParams,
  SupportedChainId,
  ItemTypeValue,
  OrderTypeValue,
} from "./types.js";

// Constants
export {
  SEAPORT_ADDRESS,
  CONDUIT_CONTROLLER,
  ItemType,
  OrderType,
  SUPPORTED_CHAINS,
  DEFAULT_API_URL,
  DEFAULT_FEE_BPS,
  DEFAULT_FEE_RECIPIENT,
  DEFAULT_LISTING_DURATION,
  DEFAULT_OFFER_DURATION,
} from "./types.js";
