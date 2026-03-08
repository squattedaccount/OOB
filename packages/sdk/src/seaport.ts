/**
 * Seaport v1.6 interaction layer.
 * Handles order construction, EIP-712 signing, and on-chain fulfillment via viem.
 */

import {
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
  parseAbi,
  getAddress,
  keccak256,
  encodeAbiParameters,
  parseAbiParameters,
} from "viem";
import {
  SEAPORT_ADDRESS,
  ItemType,
  OrderType,
  DEFAULT_ORIGIN_FEES,
  MAX_ORIGIN_FEE_BPS,
  DEFAULT_LISTING_DURATION,
  DEFAULT_OFFER_DURATION,
  type OriginFee,
  type SeaportOrderComponents,
  type SeaportOfferItem,
  type SeaportConsiderationItem,
  type OobConfig,
  type ProtocolConfig,
  type CreateListingParams,
  type CreateOfferParams,
  type CreateTargetedOfferParams,
  type AcceptOpenOfferParams,
  type FillOrderParams,
  type OobOrder,
} from "./types.js";

// ─── Seaport ABI (minimal, only what we need) ──────────────────────────────

const SEAPORT_ABI = parseAbi([
  // fulfillOrder
  "function fulfillOrder((((uint8 itemType, address token, uint256 identifierOrCriteria, uint256 startAmount, uint256 endAmount)[] offer, (uint8 itemType, address token, uint256 identifierOrCriteria, uint256 startAmount, uint256 endAmount, address recipient)[] consideration, uint8 orderType, uint256 startTime, uint256 endTime, bytes32 zoneHash, uint256 salt, bytes32 conduitKey, uint256 totalOriginalConsiderationItems) parameters, bytes signature) order, bytes32 fulfillerConduitKey) payable returns (bool fulfilled)",
  // fulfillAdvancedOrder (for tips)
  "function fulfillAdvancedOrder(((((uint8 itemType, address token, uint256 identifierOrCriteria, uint256 startAmount, uint256 endAmount)[] offer, (uint8 itemType, address token, uint256 identifierOrCriteria, uint256 startAmount, uint256 endAmount, address recipient)[] consideration, uint8 orderType, uint256 startTime, uint256 endTime, bytes32 zoneHash, uint256 salt, bytes32 conduitKey, uint256 totalOriginalConsiderationItems) parameters, uint120 numerator, uint120 denominator, bytes signature, bytes extraData) advancedOrder, (uint256 orderIndex, uint8 side, uint256 index, uint256 criteriaIndex, bytes32[] criteriaProof)[] criteriaResolvers, bytes32 fulfillerConduitKey, address recipient) payable returns (bool fulfilled)",
  // cancel
  "function cancel((address offerer, address zone, (uint8 itemType, address token, uint256 identifierOrCriteria, uint256 startAmount, uint256 endAmount)[] offer, (uint8 itemType, address token, uint256 identifierOrCriteria, uint256 startAmount, uint256 endAmount, address recipient)[] consideration, uint8 orderType, uint256 startTime, uint256 endTime, bytes32 zoneHash, uint256 salt, bytes32 conduitKey, uint256 counter)[] orders) returns (bool cancelled)",
  // getOrderStatus
  "function getOrderStatus(bytes32 orderHash) view returns (bool isValidated, bool isCancelled, uint256 totalFilled, uint256 totalSize)",
  // getCounter
  "function getCounter(address offerer) view returns (uint256 counter)",
  // validate
  "function validate((((uint8 itemType, address token, uint256 identifierOrCriteria, uint256 startAmount, uint256 endAmount)[] offer, (uint8 itemType, address token, uint256 identifierOrCriteria, uint256 startAmount, uint256 endAmount, address recipient)[] consideration, uint8 orderType, uint256 startTime, uint256 endTime, bytes32 zoneHash, uint256 salt, bytes32 conduitKey, uint256 totalOriginalConsiderationItems) parameters, bytes signature)[] orders) returns (bool validated)",
]);

const ERC721_ABI = parseAbi([
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function isApprovedForAll(address owner, address operator) view returns (bool)",
  "function setApprovalForAll(address operator, bool approved)",
]);

const ERC20_ABI = parseAbi([
  "function balanceOf(address account) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
]);

const MATCH_ADVANCED_ORDERS_ABI = [
  {
    name: "matchAdvancedOrders",
    type: "function" as const,
    stateMutability: "payable" as const,
    inputs: [
      {
        name: "orders",
        type: "tuple[]" as const,
        components: [
          {
            name: "parameters",
            type: "tuple" as const,
            components: [
              { name: "offerer", type: "address" as const },
              { name: "zone", type: "address" as const },
              {
                name: "offer",
                type: "tuple[]" as const,
                components: [
                  { name: "itemType", type: "uint8" as const },
                  { name: "token", type: "address" as const },
                  { name: "identifierOrCriteria", type: "uint256" as const },
                  { name: "startAmount", type: "uint256" as const },
                  { name: "endAmount", type: "uint256" as const },
                ],
              },
              {
                name: "consideration",
                type: "tuple[]" as const,
                components: [
                  { name: "itemType", type: "uint8" as const },
                  { name: "token", type: "address" as const },
                  { name: "identifierOrCriteria", type: "uint256" as const },
                  { name: "startAmount", type: "uint256" as const },
                  { name: "endAmount", type: "uint256" as const },
                  { name: "recipient", type: "address" as const },
                ],
              },
              { name: "orderType", type: "uint8" as const },
              { name: "startTime", type: "uint256" as const },
              { name: "endTime", type: "uint256" as const },
              { name: "zoneHash", type: "bytes32" as const },
              { name: "salt", type: "uint256" as const },
              { name: "conduitKey", type: "bytes32" as const },
              { name: "totalOriginalConsiderationItems", type: "uint256" as const },
            ],
          },
          { name: "numerator", type: "uint120" as const },
          { name: "denominator", type: "uint120" as const },
          { name: "signature", type: "bytes" as const },
          { name: "extraData", type: "bytes" as const },
        ],
      },
      {
        name: "criteriaResolvers",
        type: "tuple[]" as const,
        components: [
          { name: "orderIndex", type: "uint256" as const },
          { name: "side", type: "uint8" as const },
          { name: "index", type: "uint256" as const },
          { name: "identifier", type: "uint256" as const },
          { name: "criteriaProof", type: "bytes32[]" as const },
        ],
      },
      {
        name: "fulfillments",
        type: "tuple[]" as const,
        components: [
          {
            name: "offerComponents",
            type: "tuple[]" as const,
            components: [
              { name: "orderIndex", type: "uint256" as const },
              { name: "itemIndex", type: "uint256" as const },
            ],
          },
          {
            name: "considerationComponents",
            type: "tuple[]" as const,
            components: [
              { name: "orderIndex", type: "uint256" as const },
              { name: "itemIndex", type: "uint256" as const },
            ],
          },
        ],
      },
      { name: "recipient", type: "address" as const },
    ],
    outputs: [
      {
        name: "executions",
        type: "tuple[]" as const,
        components: [
          {
            name: "item",
            type: "tuple" as const,
            components: [
              { name: "itemType", type: "uint8" as const },
              { name: "token", type: "address" as const },
              { name: "identifier", type: "uint256" as const },
              { name: "amount", type: "uint256" as const },
              { name: "recipient", type: "address" as const },
            ],
          },
          { name: "offerer", type: "address" as const },
          { name: "conduitKey", type: "bytes32" as const },
        ],
      },
    ],
  },
] as const;

// ─── EIP-712 Domain & Types for Seaport ─────────────────────────────────────

const SEAPORT_DOMAIN_NAME = "Seaport";
const SEAPORT_DOMAIN_VERSION = "1.6";

function getSeaportDomain(chainId: number) {
  return {
    name: SEAPORT_DOMAIN_NAME,
    version: SEAPORT_DOMAIN_VERSION,
    chainId,
    verifyingContract: SEAPORT_ADDRESS as Address,
  } as const;
}

const SEAPORT_ORDER_TYPE = {
  OrderComponents: [
    { name: "offerer", type: "address" },
    { name: "zone", type: "address" },
    { name: "offer", type: "OfferItem[]" },
    { name: "consideration", type: "ConsiderationItem[]" },
    { name: "orderType", type: "uint8" },
    { name: "startTime", type: "uint256" },
    { name: "endTime", type: "uint256" },
    { name: "zoneHash", type: "bytes32" },
    { name: "salt", type: "uint256" },
    { name: "conduitKey", type: "bytes32" },
    { name: "counter", type: "uint256" },
  ],
  OfferItem: [
    { name: "itemType", type: "uint8" },
    { name: "token", type: "address" },
    { name: "identifierOrCriteria", type: "uint256" },
    { name: "startAmount", type: "uint256" },
    { name: "endAmount", type: "uint256" },
  ],
  ConsiderationItem: [
    { name: "itemType", type: "uint8" },
    { name: "token", type: "address" },
    { name: "identifierOrCriteria", type: "uint256" },
    { name: "startAmount", type: "uint256" },
    { name: "endAmount", type: "uint256" },
    { name: "recipient", type: "address" },
  ],
} as const;

// ─── Seaport Client ─────────────────────────────────────────────────────────

export class SeaportClient {
  private chainId: number;
  private originFees: OriginFee[];

  constructor(config: OobConfig) {
    this.chainId = config.chainId;
    this.originFees = config.originFees ?? DEFAULT_ORIGIN_FEES;
  }

  // ─── Order Construction ─────────────────────────────────────────────────

  /**
   * Build and sign a listing order (seller offers NFT, wants payment).
   * Returns the signed order components + signature.
   *
   * The order includes up to 3 fee consideration items:
   * 1. Protocol fee (OOB) — fetched from API, non-negotiable
   * 2. Origin fee — configured by the marketplace/integrator using the SDK
   * 3. Royalty — optional, specified per-listing
   */
  async createListing(
    params: CreateListingParams,
    walletClient: WalletClient,
    publicClient: PublicClient,
    protocolConfig?: ProtocolConfig,
  ): Promise<{ order: SeaportOrderComponents; signature: Hex }> {
    const account = walletClient.account;
    if (!account) throw new Error("WalletClient must have an account");

    const seller = getAddress(account.address);
    const priceWei = BigInt(params.priceWei);
    const currency = params.currency ?? "0x0000000000000000000000000000000000000000";
    const isNative = currency === "0x0000000000000000000000000000000000000000";
    const currencyItemType = isNative ? ItemType.NATIVE : ItemType.ERC20;

    // Calculate protocol fee (from API config)
    const protocolFeeBps = protocolConfig?.protocolFeeBps ?? 0;
    const protocolFeeRecipient = protocolConfig?.protocolFeeRecipient ?? "";
    const royaltyBps = params.royaltyBps ?? 0;
    const totalOriginFeeBps = this.originFees.reduce((sum, originFee) => sum + originFee.bps, 0);

    // Validate total deductions do not exceed 100%
    const totalBps = protocolFeeBps + totalOriginFeeBps + royaltyBps;
    if (totalBps > 10000) {
      throw new Error(
        `Total fees exceed 100%: protocolFee=${protocolFeeBps} + originFee=${totalOriginFeeBps} + royalty=${royaltyBps} = ${totalBps} bps`,
      );
    }

    const protocolFeeAmount = protocolFeeBps > 0 && protocolFeeRecipient
      ? (priceWei * BigInt(protocolFeeBps)) / 10000n
      : 0n;

    const originFeeAmounts = this.originFees.map((originFee) => ({
      recipient: originFee.recipient,
      amount: (priceWei * BigInt(originFee.bps)) / 10000n,
    })).filter((originFee) => originFee.amount > 0n);

    const originFeeAmount = originFeeAmounts.reduce((sum, originFee) => sum + originFee.amount, 0n);

    const totalFees = protocolFeeAmount + originFeeAmount;
    const sellerProceeds = priceWei - totalFees;

    // Build consideration items
    const consideration: SeaportConsiderationItem[] = [
      {
        itemType: currencyItemType,
        token: currency,
        identifierOrCriteria: "0",
        startAmount: sellerProceeds.toString(),
        endAmount: sellerProceeds.toString(),
        recipient: seller,
      },
    ];

    // Add protocol fee (OOB)
    if (protocolFeeAmount > 0n && protocolFeeRecipient) {
      consideration.push({
        itemType: currencyItemType,
        token: currency,
        identifierOrCriteria: "0",
        startAmount: protocolFeeAmount.toString(),
        endAmount: protocolFeeAmount.toString(),
        recipient: getAddress(protocolFeeRecipient),
      });
    }

    // Add origin fee splits
    for (const originFee of originFeeAmounts) {
      consideration.push({
        itemType: currencyItemType,
        token: currency,
        identifierOrCriteria: "0",
        startAmount: originFee.amount.toString(),
        endAmount: originFee.amount.toString(),
        recipient: getAddress(originFee.recipient),
      });
    }

    // Add royalty if specified
    if (params.royaltyBps && params.royaltyRecipient) {
      const royaltyAmount = (priceWei * BigInt(params.royaltyBps)) / 10000n;
      // Royalty comes from seller proceeds
      consideration[0].startAmount = (sellerProceeds - royaltyAmount).toString();
      consideration[0].endAmount = (sellerProceeds - royaltyAmount).toString();
      consideration.push({
        itemType: currencyItemType,
        token: currency,
        identifierOrCriteria: "0",
        startAmount: royaltyAmount.toString(),
        endAmount: royaltyAmount.toString(),
        recipient: getAddress(params.royaltyRecipient),
      });
    }

    const now = Math.floor(Date.now() / 1000);
    const duration = params.duration ?? DEFAULT_LISTING_DURATION;

    // Get Seaport counter for this offerer
    const counter = await publicClient.readContract({
      address: SEAPORT_ADDRESS as Address,
      abi: SEAPORT_ABI,
      functionName: "getCounter",
      args: [seller],
    }) as bigint;

    const salt = BigInt(keccak256(
      encodeAbiParameters(
        parseAbiParameters("address, uint256, uint256"),
        [seller, BigInt(now), BigInt(Math.floor(Math.random() * 1e18))],
      ),
    ));

    const order: SeaportOrderComponents = {
      offerer: seller,
      zone: "0x0000000000000000000000000000000000000000",
      offer: [
        {
          itemType: params.tokenStandard === "ERC1155" ? ItemType.ERC1155 : ItemType.ERC721,
          token: getAddress(params.collection),
          identifierOrCriteria: params.tokenId,
          startAmount: params.quantity ? String(params.quantity) : "1",
          endAmount: params.quantity ? String(params.quantity) : "1",
        },
      ],
      consideration,
      orderType: OrderType.FULL_OPEN,
      startTime: now.toString(),
      endTime: (now + duration).toString(),
      zoneHash: "0x0000000000000000000000000000000000000000000000000000000000000000",
      salt: salt.toString(),
      conduitKey: "0x0000000000000000000000000000000000000000000000000000000000000000",
      counter: counter.toString(),
    };

    const signature = await this.signOrder(order, walletClient);

    return { order, signature };
  }

  /**
   * Build and sign an offer order (buyer offers ERC20, wants NFT).
   * Open offers and collection offers require a match/mirror-order flow and are not
   * currently supported by this helper.
   */
  async createOffer(
    params: CreateOfferParams,
    walletClient: WalletClient,
    publicClient: PublicClient,
    protocolConfig?: ProtocolConfig,
  ): Promise<{ order: SeaportOrderComponents; signature: Hex }> {
    const account = walletClient.account;
    if (!account) throw new Error("WalletClient must have an account");

    const offerer = getAddress(account.address);
    const amountWei = BigInt(params.amountWei);
    const currency = getAddress(params.currency);
    const protocolFeeBps = protocolConfig?.protocolFeeBps ?? 0;
    const protocolFeeRecipient = protocolConfig?.protocolFeeRecipient ?? "";
    const royaltyBps = params.royaltyBps ?? 0;
    const totalOriginFeeBps = this.originFees.reduce((sum, originFee) => sum + originFee.bps, 0);
    const totalFeeBps = protocolFeeBps + totalOriginFeeBps + royaltyBps;

    if (totalFeeBps > 10000) {
      throw new Error(
        `Total fees exceed 100%: protocolFee=${protocolFeeBps} + originFee=${totalOriginFeeBps} + royalty=${royaltyBps} = ${totalFeeBps} bps`,
      );
    }

    const protocolFeeAmount = protocolFeeBps > 0 && protocolFeeRecipient
      ? (amountWei * BigInt(protocolFeeBps)) / 10000n
      : 0n;
    const originFeeAmounts = this.originFees.map((originFee) => ({
      recipient: originFee.recipient,
      amount: (amountWei * BigInt(originFee.bps)) / 10000n,
    })).filter((originFee) => originFee.amount > 0n);

    const isERC1155 = params.tokenStandard === "ERC1155";
    const hasSpecificTokenId = params.tokenId !== undefined;
    const criteriaIdentifier = params.tokenId ?? "0";
    const nftItemType = hasSpecificTokenId
      ? (isERC1155 ? ItemType.ERC1155 : ItemType.ERC721)
      : (isERC1155 ? ItemType.ERC1155_WITH_CRITERIA : ItemType.ERC721_WITH_CRITERIA);
    const nftQuantity = params.quantity ? String(params.quantity) : "1";

    const consideration: SeaportConsiderationItem[] = [
      {
        itemType: nftItemType,
        token: getAddress(params.collection),
        identifierOrCriteria: criteriaIdentifier,
        startAmount: nftQuantity,
        endAmount: nftQuantity,
        recipient: offerer,
      },
    ];

    if (protocolFeeAmount > 0n && protocolFeeRecipient) {
      consideration.push({
        itemType: ItemType.ERC20,
        token: currency,
        identifierOrCriteria: "0",
        startAmount: protocolFeeAmount.toString(),
        endAmount: protocolFeeAmount.toString(),
        recipient: getAddress(protocolFeeRecipient),
      });
    }

    for (const originFee of originFeeAmounts) {
      consideration.push({
        itemType: ItemType.ERC20,
        token: currency,
        identifierOrCriteria: "0",
        startAmount: originFee.amount.toString(),
        endAmount: originFee.amount.toString(),
        recipient: getAddress(originFee.recipient),
      });
    }

    if (royaltyBps > 0 && params.royaltyRecipient) {
      const royaltyAmount = (amountWei * BigInt(royaltyBps)) / 10000n;
      if (royaltyAmount > 0n) {
        consideration.push({
          itemType: ItemType.ERC20,
          token: currency,
          identifierOrCriteria: "0",
          startAmount: royaltyAmount.toString(),
          endAmount: royaltyAmount.toString(),
          recipient: getAddress(params.royaltyRecipient),
        });
      }
    }

    const now = Math.floor(Date.now() / 1000);
    const duration = params.duration ?? DEFAULT_OFFER_DURATION;
    const counter = await publicClient.readContract({
      address: SEAPORT_ADDRESS as Address,
      abi: SEAPORT_ABI,
      functionName: "getCounter",
      args: [offerer],
    }) as bigint;
    const salt = BigInt(keccak256(
      encodeAbiParameters(
        parseAbiParameters("address, uint256, uint256"),
        [offerer, BigInt(now), BigInt(Math.floor(Math.random() * 1e18))],
      ),
    ));

    const order: SeaportOrderComponents = {
      offerer,
      zone: "0x0000000000000000000000000000000000000000",
      offer: [
        {
          itemType: ItemType.ERC20,
          token: currency,
          identifierOrCriteria: "0",
          startAmount: amountWei.toString(),
          endAmount: amountWei.toString(),
        },
      ],
      consideration,
      orderType: OrderType.FULL_OPEN,
      startTime: now.toString(),
      endTime: (now + duration).toString(),
      zoneHash: "0x0000000000000000000000000000000000000000000000000000000000000000",
      salt: salt.toString(),
      conduitKey: "0x0000000000000000000000000000000000000000000000000000000000000000",
      counter: counter.toString(),
    };

    const signature = await this.signOrder(order, walletClient);
    return { order, signature };
  }

  async createTargetedOffer(
    params: CreateTargetedOfferParams,
    walletClient: WalletClient,
    publicClient: PublicClient,
    protocolConfig?: ProtocolConfig,
  ): Promise<{ order: SeaportOrderComponents; signature: Hex }> {
    const account = walletClient.account;
    if (!account) throw new Error("WalletClient must have an account");

    const offerer = getAddress(account.address);
    const seller = getAddress(params.seller);
    const amountWei = BigInt(params.amountWei);
    const currency = getAddress(params.currency);
    const royaltyBps = params.royaltyBps ?? 0;
    const protocolFeeBps = protocolConfig?.protocolFeeBps ?? 0;
    const protocolFeeRecipient = protocolConfig?.protocolFeeRecipient ?? "";
    const totalOriginFeeBps = this.originFees.reduce((sum, originFee) => sum + originFee.bps, 0);
    const totalFeeBps = protocolFeeBps + totalOriginFeeBps + royaltyBps;

    if (totalFeeBps > 10000) {
      throw new Error(
        `Total fees exceed 100%: protocolFee=${protocolFeeBps} + originFee=${totalOriginFeeBps} + royalty=${royaltyBps} = ${totalFeeBps} bps`,
      );
    }

    const protocolFeeAmount = protocolFeeBps > 0 && protocolFeeRecipient
      ? (amountWei * BigInt(protocolFeeBps)) / 10000n
      : 0n;
    const originFeeAmounts = this.originFees.map((originFee) => ({
      recipient: originFee.recipient,
      amount: (amountWei * BigInt(originFee.bps)) / 10000n,
    })).filter((originFee) => originFee.amount > 0n);
    const royaltyAmount = royaltyBps > 0 && params.royaltyRecipient
      ? (amountWei * BigInt(royaltyBps)) / 10000n
      : 0n;
    const sellerPayout = amountWei - protocolFeeAmount - royaltyAmount - originFeeAmounts.reduce((sum, item) => sum + item.amount, 0n);

    if (sellerPayout <= 0n) {
      throw new Error("Targeted offer net seller payout must be greater than zero");
    }

    const isERC1155 = params.tokenStandard === "ERC1155";
    const nftItemType = isERC1155 ? ItemType.ERC1155 : ItemType.ERC721;
    const nftQuantity = params.quantity ? String(params.quantity) : "1";

    const consideration: SeaportConsiderationItem[] = [
      {
        itemType: nftItemType,
        token: getAddress(params.collection),
        identifierOrCriteria: params.tokenId,
        startAmount: nftQuantity,
        endAmount: nftQuantity,
        recipient: offerer,
      },
      {
        itemType: ItemType.ERC20,
        token: currency,
        identifierOrCriteria: "0",
        startAmount: sellerPayout.toString(),
        endAmount: sellerPayout.toString(),
        recipient: seller,
      },
    ];

    if (protocolFeeAmount > 0n && protocolFeeRecipient) {
      consideration.push({
        itemType: ItemType.ERC20,
        token: currency,
        identifierOrCriteria: "0",
        startAmount: protocolFeeAmount.toString(),
        endAmount: protocolFeeAmount.toString(),
        recipient: getAddress(protocolFeeRecipient),
      });
    }

    for (const originFee of originFeeAmounts) {
      consideration.push({
        itemType: ItemType.ERC20,
        token: currency,
        identifierOrCriteria: "0",
        startAmount: originFee.amount.toString(),
        endAmount: originFee.amount.toString(),
        recipient: getAddress(originFee.recipient),
      });
    }

    if (royaltyAmount > 0n && params.royaltyRecipient) {
      consideration.push({
        itemType: ItemType.ERC20,
        token: currency,
        identifierOrCriteria: "0",
        startAmount: royaltyAmount.toString(),
        endAmount: royaltyAmount.toString(),
        recipient: getAddress(params.royaltyRecipient),
      });
    }

    const now = Math.floor(Date.now() / 1000);
    const duration = params.duration ?? DEFAULT_OFFER_DURATION;
    const counter = await publicClient.readContract({
      address: SEAPORT_ADDRESS as Address,
      abi: SEAPORT_ABI,
      functionName: "getCounter",
      args: [offerer],
    }) as bigint;
    const salt = BigInt(keccak256(
      encodeAbiParameters(
        parseAbiParameters("address, uint256, uint256"),
        [offerer, BigInt(now), BigInt(Math.floor(Math.random() * 1e18))],
      ),
    ));

    const order: SeaportOrderComponents = {
      offerer,
      zone: "0x0000000000000000000000000000000000000000",
      offer: [
        {
          itemType: ItemType.ERC20,
          token: currency,
          identifierOrCriteria: "0",
          startAmount: amountWei.toString(),
          endAmount: amountWei.toString(),
        },
      ],
      consideration,
      orderType: OrderType.FULL_OPEN,
      startTime: now.toString(),
      endTime: (now + duration).toString(),
      zoneHash: "0x0000000000000000000000000000000000000000000000000000000000000000",
      salt: salt.toString(),
      conduitKey: "0x0000000000000000000000000000000000000000000000000000000000000000",
      counter: counter.toString(),
    };

    const signature = await this.signOrder(order, walletClient);
    return { order, signature };
  }

  // ─── Order Fulfillment ──────────────────────────────────────────────────

  /**
   * Fill an order on-chain. Handles both standard fill and fill-with-tip.
   * Returns the transaction hash.
   */
  async fillOrder(
    oobOrder: OobOrder,
    walletClient: WalletClient,
    publicClient: PublicClient,
    params?: FillOrderParams,
  ): Promise<Hex> {
    const account = walletClient.account;
    if (!account) throw new Error("WalletClient must have an account");

    const orderComponents = oobOrder.orderJson;
    const signature = oobOrder.signature as Hex;

    // Calculate total ETH value needed (for listings paid in native ETH)
    let value = 0n;
    if (oobOrder.orderType === "listing") {
      for (const item of orderComponents.consideration) {
        if (Number(item.itemType) === ItemType.NATIVE) {
          value += BigInt(item.startAmount);
        }
      }
    }

    if (params?.tip && params.tip.basisPoints > 0) {
      // Tipping: use fulfillAdvancedOrder.
      // Seaport tipping works by appending extra consideration items BEYOND
      // totalOriginalConsiderationItems. The fulfiller pays these extra items.
      const tipAmount = (BigInt(oobOrder.priceWei) * BigInt(params.tip.basisPoints)) / 10000n;
      if (tipAmount <= 0n) throw new Error("Tip amount must be greater than zero");

      const tipRecipient = getAddress(params.tip.recipient);

      // Determine tip currency — match the order's payment currency
      const isNativePayment = oobOrder.currency === "0x0000000000000000000000000000000000000000";
      const tipItemType = isNativePayment ? ItemType.NATIVE : ItemType.ERC20;

      // Add tip to the ETH value the buyer must send (for native payments)
      if (isNativePayment) {
        value += tipAmount;
      }

      // Build order parameters with the tip appended as extra consideration
      const orderParams = this.buildOrderParameters(orderComponents);

      // Append the tip as an additional consideration item.
      // totalOriginalConsiderationItems stays the same (from the original order),
      // so Seaport knows items beyond that index are tips from the fulfiller.
      const considerationWithTip = [
        ...orderParams.consideration,
        {
          itemType: tipItemType,
          token: (isNativePayment ? "0x0000000000000000000000000000000000000000" : oobOrder.currency) as Address,
          identifierOrCriteria: 0n,
          startAmount: tipAmount,
          endAmount: tipAmount,
          recipient: tipRecipient,
        },
      ];

      const hash = await walletClient.writeContract({
        address: SEAPORT_ADDRESS as Address,
        abi: SEAPORT_ABI,
        functionName: "fulfillAdvancedOrder",
        args: [
          {
            parameters: {
              ...orderParams,
              consideration: considerationWithTip,
            },
            numerator: 1n,
            denominator: 1n,
            signature,
            extraData: "0x" as Hex,
          },
          [], // criteriaResolvers
          "0x0000000000000000000000000000000000000000000000000000000000000000" as Hex, // fulfillerConduitKey
          "0x0000000000000000000000000000000000000000" as Address, // recipient (0 = msg.sender)
        ],
        value,
        account,
        chain: walletClient.chain,
      });

      return hash;
    } else {
      // Standard fulfillOrder (no tip)
      const orderParams = this.buildOrderParameters(orderComponents);

      const hash = await walletClient.writeContract({
        address: SEAPORT_ADDRESS as Address,
        abi: SEAPORT_ABI,
        functionName: "fulfillOrder",
        args: [
          {
            parameters: orderParams,
            signature,
          },
          "0x0000000000000000000000000000000000000000000000000000000000000000" as Hex, // fulfillerConduitKey
        ],
        value,
        account,
        chain: walletClient.chain,
      });

      return hash;
    }
  }

  async acceptOpenOffer(
    oobOrder: OobOrder,
    walletClient: WalletClient,
    publicClient: PublicClient,
    params?: AcceptOpenOfferParams,
  ): Promise<Hex> {
    const account = walletClient.account;
    if (!account) throw new Error("WalletClient must have an account");

    const criteriaResolvers = this.buildOpenOfferCriteriaResolvers(oobOrder, params);
    const originalParams = this.buildOrderParameters(oobOrder.orderJson);
    const { mirrorOrder, value } = await this.buildMirrorAcceptOfferOrder(
      oobOrder,
      walletClient,
      publicClient,
      criteriaResolvers,
    );

    return walletClient.writeContract({
      address: SEAPORT_ADDRESS as Address,
      abi: MATCH_ADVANCED_ORDERS_ABI,
      functionName: "matchAdvancedOrders",
      args: [
        [
          {
            parameters: originalParams,
            numerator: 1n,
            denominator: 1n,
            signature: oobOrder.signature as Hex,
            extraData: "0x" as Hex,
          },
          mirrorOrder,
        ],
        criteriaResolvers,
        this.buildAcceptOfferFulfillments(oobOrder.orderJson),
        "0x0000000000000000000000000000000000000000" as Address,
      ],
      value,
      account,
      chain: walletClient.chain,
    });
  }

  /**
   * Cancel orders on-chain.
   */
  async cancelOrders(
    orders: SeaportOrderComponents[],
    walletClient: WalletClient,
  ): Promise<Hex> {
    const account = walletClient.account;
    if (!account) throw new Error("WalletClient must have an account");

    const hash = await walletClient.writeContract({
      address: SEAPORT_ADDRESS as Address,
      abi: SEAPORT_ABI,
      functionName: "cancel",
      args: [orders.map((o) => this.buildOrderComponentsForCancel(o))],
      account,
      chain: walletClient.chain,
    });

    return hash;
  }

  // ─── On-Chain Reads ─────────────────────────────────────────────────────

  /**
   * Check if a wallet has approved Seaport for a given NFT collection.
   */
  async isApprovedForAll(
    collection: Address,
    owner: Address,
    publicClient: PublicClient,
  ): Promise<boolean> {
    return publicClient.readContract({
      address: collection,
      abi: ERC721_ABI,
      functionName: "isApprovedForAll",
      args: [owner, SEAPORT_ADDRESS as Address],
    });
  }

  /**
   * Check the on-chain status of a Seaport order.
   */
  async getOrderStatus(
    orderHash: Hex,
    publicClient: PublicClient,
  ): Promise<{
    isValidated: boolean;
    isCancelled: boolean;
    totalFilled: bigint;
    totalSize: bigint;
  }> {
    const result = await publicClient.readContract({
      address: SEAPORT_ADDRESS as Address,
      abi: SEAPORT_ABI,
      functionName: "getOrderStatus",
      args: [orderHash],
    }) as [boolean, boolean, bigint, bigint];
    const [isValidated, isCancelled, totalFilled, totalSize] = result;

    return { isValidated, isCancelled, totalFilled, totalSize };
  }

  /**
   * Check ERC20 balance and allowance (useful for offers with WETH).
   */
  async checkErc20Readiness(
    token: Address,
    owner: Address,
    requiredAmount: bigint,
    publicClient: PublicClient,
  ): Promise<{
    balance: bigint;
    allowance: bigint;
    hasBalance: boolean;
    hasAllowance: boolean;
    needsApproval: boolean;
  }> {
    const [balance, allowance] = await Promise.all([
      publicClient.readContract({
        address: token,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [owner],
      }),
      publicClient.readContract({
        address: token,
        abi: ERC20_ABI,
        functionName: "allowance",
        args: [owner, SEAPORT_ADDRESS as Address],
      }),
    ]);

    return {
      balance,
      allowance,
      hasBalance: balance >= requiredAmount,
      hasAllowance: allowance >= requiredAmount,
      needsApproval: allowance < requiredAmount,
    };
  }

  /**
   * Approve Seaport to transfer NFTs from a collection.
   */
  async approveNftCollection(
    collection: Address,
    walletClient: WalletClient,
  ): Promise<Hex> {
    const account = walletClient.account;
    if (!account) throw new Error("WalletClient must have an account");

    return walletClient.writeContract({
      address: collection,
      abi: ERC721_ABI,
      functionName: "setApprovalForAll",
      args: [SEAPORT_ADDRESS as Address, true],
      account,
      chain: walletClient.chain,
    });
  }

  /**
   * Approve Seaport to spend ERC20 tokens (e.g. WETH for offers).
   */
  async approveErc20(
    token: Address,
    amount: bigint,
    walletClient: WalletClient,
  ): Promise<Hex> {
    const account = walletClient.account;
    if (!account) throw new Error("WalletClient must have an account");

    return walletClient.writeContract({
      address: token,
      abi: ERC20_ABI,
      functionName: "approve",
      args: [SEAPORT_ADDRESS as Address, amount],
      account,
      chain: walletClient.chain,
    });
  }

  // ─── EIP-712 Signing ───────────────────────────────────────────────────

  private async signOrder(
    order: SeaportOrderComponents,
    walletClient: WalletClient,
  ): Promise<Hex> {
    const account = walletClient.account;
    if (!account) throw new Error("WalletClient must have an account");

    const domain = getSeaportDomain(this.chainId);

    const signature = await walletClient.signTypedData({
      account,
      domain,
      types: SEAPORT_ORDER_TYPE,
      primaryType: "OrderComponents",
      message: {
        offerer: order.offerer as Address,
        zone: order.zone as Address,
        offer: order.offer.map((item) => ({
          itemType: item.itemType,
          token: item.token as Address,
          identifierOrCriteria: BigInt(item.identifierOrCriteria),
          startAmount: BigInt(item.startAmount),
          endAmount: BigInt(item.endAmount),
        })),
        consideration: order.consideration.map((item) => ({
          itemType: item.itemType,
          token: item.token as Address,
          identifierOrCriteria: BigInt(item.identifierOrCriteria),
          startAmount: BigInt(item.startAmount),
          endAmount: BigInt(item.endAmount),
          recipient: item.recipient as Address,
        })),
        orderType: order.orderType,
        startTime: BigInt(order.startTime),
        endTime: BigInt(order.endTime),
        zoneHash: order.zoneHash as Hex,
        salt: BigInt(order.salt),
        conduitKey: order.conduitKey as Hex,
        counter: BigInt(order.counter),
      },
    });

    return signature;
  }

  // ─── Struct Builders ──────────────────────────────────────────────────

  private buildOrderParameters(order: SeaportOrderComponents) {
    return {
      offerer: order.offerer as Address,
      zone: order.zone as Address,
      offer: order.offer.map((item) => ({
        itemType: item.itemType,
        token: item.token as Address,
        identifierOrCriteria: BigInt(item.identifierOrCriteria),
        startAmount: BigInt(item.startAmount),
        endAmount: BigInt(item.endAmount),
      })),
      consideration: order.consideration.map((item) => ({
        itemType: item.itemType,
        token: item.token as Address,
        identifierOrCriteria: BigInt(item.identifierOrCriteria),
        startAmount: BigInt(item.startAmount),
        endAmount: BigInt(item.endAmount),
        recipient: item.recipient as Address,
      })),
      orderType: order.orderType,
      startTime: BigInt(order.startTime),
      endTime: BigInt(order.endTime),
      zoneHash: order.zoneHash as Hex,
      salt: BigInt(order.salt),
      conduitKey: order.conduitKey as Hex,
      totalOriginalConsiderationItems: BigInt(order.consideration.length),
    };
  }

  private buildOrderComponentsForCancel(order: SeaportOrderComponents) {
    return {
      offerer: order.offerer as Address,
      zone: order.zone as Address,
      offer: order.offer.map((item) => ({
        itemType: item.itemType,
        token: item.token as Address,
        identifierOrCriteria: BigInt(item.identifierOrCriteria),
        startAmount: BigInt(item.startAmount),
        endAmount: BigInt(item.endAmount),
      })),
      consideration: order.consideration.map((item) => ({
        itemType: item.itemType,
        token: item.token as Address,
        identifierOrCriteria: BigInt(item.identifierOrCriteria),
        startAmount: BigInt(item.startAmount),
        endAmount: BigInt(item.endAmount),
        recipient: item.recipient as Address,
      })),
      orderType: order.orderType,
      startTime: BigInt(order.startTime),
      endTime: BigInt(order.endTime),
      zoneHash: order.zoneHash as Hex,
      salt: BigInt(order.salt),
      conduitKey: order.conduitKey as Hex,
      counter: BigInt(order.counter),
    };
  }

  private buildOpenOfferCriteriaResolvers(oobOrder: OobOrder, params?: AcceptOpenOfferParams) {
    const nftItem = oobOrder.orderJson.consideration.find((item) => Number(item.itemType) >= ItemType.ERC721);
    if (!nftItem) {
      throw new Error("Open offer is missing the NFT consideration item");
    }

    const itemType = Number(nftItem.itemType);
    if (itemType !== ItemType.ERC721_WITH_CRITERIA && itemType !== ItemType.ERC1155_WITH_CRITERIA) {
      return [];
    }

    if (!params?.tokenId) {
      throw new Error("acceptOpenOffer() requires tokenId when accepting collection or criteria offers");
    }

    const isCriteria = (oobOrder.assetScope ?? "token") === "criteria" || (oobOrder.identifierOrCriteria ?? "0") !== "0";
    if (isCriteria && params.criteriaProof === undefined) {
      throw new Error("acceptOpenOffer() requires criteriaProof for criteria-based offers");
    }

    return [
      {
        orderIndex: 0n,
        side: 1,
        index: 0n,
        identifier: BigInt(params.tokenId),
        criteriaProof: (params.criteriaProof ?? []) as Hex[],
      },
    ];
  }

  private async buildMirrorAcceptOfferOrder(
    oobOrder: OobOrder,
    walletClient: WalletClient,
    publicClient: PublicClient,
    criteriaResolvers: Array<{ orderIndex: bigint; side: number; index: bigint; identifier: bigint; criteriaProof: Hex[] }>,
  ) {
    const account = walletClient.account;
    if (!account) throw new Error("WalletClient must have an account");

    const seller = getAddress(account.address);
    const order = oobOrder.orderJson;
    const resolvedIdentifier = criteriaResolvers[0]?.identifier;
    const mirrorOffer = order.consideration
      .filter((item) => Number(item.itemType) >= ItemType.ERC721)
      .map((item) => ({
        itemType: Number(item.itemType) < ItemType.ERC721_WITH_CRITERIA
          ? item.itemType
          : (Number(item.itemType) - 2) as typeof item.itemType,
        token: getAddress(item.token),
        identifierOrCriteria: resolvedIdentifier !== undefined
          ? resolvedIdentifier.toString()
          : item.identifierOrCriteria,
        startAmount: item.startAmount,
        endAmount: item.endAmount,
      }));

    const mirrorConsideration = order.offer.map((item) => {
      const itemType = Number(item.itemType);
      const deductedAmount = order.consideration
        .filter((considerationItem) => Number(considerationItem.itemType) < ItemType.ERC721)
        .filter((considerationItem) => Number(considerationItem.itemType) === itemType)
        .filter((considerationItem) => getAddress(considerationItem.token) === getAddress(item.token))
        .reduce((sum, considerationItem) => sum + BigInt(considerationItem.endAmount), 0n);
      const netAmount = BigInt(item.endAmount) - deductedAmount;
      if (netAmount <= 0n) {
        throw new Error("Open offer mirror order would leave the seller with zero payout");
      }
      return {
        itemType: itemType < ItemType.ERC721_WITH_CRITERIA ? item.itemType : ((itemType - 2) as typeof item.itemType),
        token: getAddress(item.token),
        identifierOrCriteria: resolvedIdentifier !== undefined ? resolvedIdentifier.toString() : item.identifierOrCriteria,
        recipient: seller,
        startAmount: netAmount.toString(),
        endAmount: netAmount.toString(),
      };
    });

    const counter = await publicClient.readContract({
      address: SEAPORT_ADDRESS as Address,
      abi: SEAPORT_ABI,
      functionName: "getCounter",
      args: [seller],
    }) as bigint;
    const salt = BigInt(keccak256(
      encodeAbiParameters(
        parseAbiParameters("address, uint256, uint256"),
        [seller, BigInt(Math.floor(Date.now() / 1000)), BigInt(Math.floor(Math.random() * 1e18))],
      ),
    ));

    const mirrorComponents: SeaportOrderComponents = {
      offerer: seller,
      zone: "0x0000000000000000000000000000000000000000",
      offer: mirrorOffer,
      consideration: mirrorConsideration,
      orderType: OrderType.FULL_OPEN,
      startTime: oobOrder.orderJson.startTime,
      endTime: oobOrder.orderJson.endTime,
      zoneHash: "0x0000000000000000000000000000000000000000000000000000000000000000",
      salt: salt.toString(),
      conduitKey: "0x0000000000000000000000000000000000000000000000000000000000000000",
      counter: counter.toString(),
    };

    const signature = await this.signOrder(mirrorComponents, walletClient);
    const value = mirrorConsideration.reduce(
      (sum, item) => sum + (Number(item.itemType) === ItemType.NATIVE ? BigInt(item.endAmount) : 0n),
      0n,
    );

    return {
      mirrorOrder: {
        parameters: this.buildOrderParameters(mirrorComponents),
        numerator: 1n,
        denominator: 1n,
        signature,
        extraData: "0x" as Hex,
      },
      value,
    };
  }

  private buildAcceptOfferFulfillments(order: SeaportOrderComponents) {
    const fulfillments = [
      {
        offerComponents: [{ orderIndex: 1n, itemIndex: 0n }],
        considerationComponents: [{ orderIndex: 0n, itemIndex: 0n }],
      },
      {
        offerComponents: [{ orderIndex: 0n, itemIndex: 0n }],
        considerationComponents: [{ orderIndex: 1n, itemIndex: 0n }],
      },
    ];

    for (let i = 1; i < order.consideration.length; i += 1) {
      fulfillments.push({
        offerComponents: [{ orderIndex: 0n, itemIndex: 0n }],
        considerationComponents: [{ orderIndex: 0n, itemIndex: BigInt(i) }],
      });
    }

    return fulfillments;
  }
}
