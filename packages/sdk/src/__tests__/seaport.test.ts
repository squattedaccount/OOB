import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("viem", () => ({
  parseAbi: vi.fn(() => []),
  getAddress: vi.fn((addr: string) => addr),
  keccak256: vi.fn(() => "0x" + "1".repeat(64)),
  encodeAbiParameters: vi.fn(() => "0xdeadbeef"),
  parseAbiParameters: vi.fn(() => []),
}));

import { SeaportClient } from "../seaport.js";
import { ItemType, OrderType, type OobOrder, type SeaportOrderComponents } from "../types.js";

function makeWallet(address = "0x1111111111111111111111111111111111111111") {
  return {
    account: { address },
    chain: { id: 8453 },
    signTypedData: vi.fn().mockResolvedValue("0xsig"),
    writeContract: vi.fn().mockResolvedValue("0xtxhash"),
  } as any;
}

function makePublicClient(counter = 7n) {
  return {
    readContract: vi.fn().mockResolvedValue(counter),
  } as any;
}

function makeBaseOfferOrder(overrides: Partial<OobOrder> = {}): OobOrder {
  const orderJson: SeaportOrderComponents = {
    offerer: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    zone: "0x0000000000000000000000000000000000000000",
    offer: [
      {
        itemType: ItemType.ERC20,
        token: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
        identifierOrCriteria: "0",
        startAmount: "10000",
        endAmount: "10000",
      },
    ],
    consideration: [
      {
        itemType: ItemType.ERC721_WITH_CRITERIA,
        token: "0x2222222222222222222222222222222222222222",
        identifierOrCriteria: "0",
        startAmount: "1",
        endAmount: "1",
        recipient: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      },
      {
        itemType: ItemType.ERC20,
        token: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
        identifierOrCriteria: "0",
        startAmount: "33",
        endAmount: "33",
        recipient: "0x0000000000000000000000000000000000000001",
      },
    ],
    orderType: OrderType.FULL_OPEN,
    startTime: "1",
    endTime: "9999999999",
    zoneHash: "0x" + "0".repeat(64),
    salt: "1",
    conduitKey: "0x" + "0".repeat(64),
    counter: "0",
  };

  return {
    orderHash: "0xhash",
    chainId: 8453,
    orderType: "offer",
    offerer: orderJson.offerer,
    nftContract: "0x2222222222222222222222222222222222222222",
    tokenId: "0",
    assetScope: "collection",
    identifierOrCriteria: "0",
    tokenStandard: "ERC721",
    priceWei: "10000",
    currency: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
    protocolFeeRecipient: "0x0000000000000000000000000000000000000001",
    protocolFeeBps: 33,
    originFees: [],
    royaltyRecipient: null,
    royaltyBps: 0,
    startTime: 1,
    endTime: 9999999999,
    status: "active",
    createdAt: new Date().toISOString(),
    filledTxHash: null,
    filledAt: null,
    cancelledTxHash: null,
    cancelledAt: null,
    orderJson,
    signature: "0xsig",
    ...overrides,
  };
}

describe("SeaportClient", () => {
  let client: SeaportClient;

  beforeEach(() => {
    client = new SeaportClient({ chainId: 8453 });
  });

  describe("createOffer", () => {
    it("builds a token-scoped open offer with exact NFT item type", async () => {
      const wallet = makeWallet();
      const pub = makePublicClient();

      const result = await client.createOffer(
        {
          collection: "0x2222222222222222222222222222222222222222",
          tokenId: "42",
          amountWei: "10000",
          currency: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
        },
        wallet,
        pub,
        { protocolFeeBps: 33, protocolFeeRecipient: "0x0000000000000000000000000000000000000001" },
      );

      expect(result.order.consideration[0].itemType).toBe(ItemType.ERC721);
      expect(result.order.consideration[0].identifierOrCriteria).toBe("42");
      expect(result.order.offer[0].itemType).toBe(ItemType.ERC20);
    });

    it("builds a collection open offer with criteria item type", async () => {
      const wallet = makeWallet();
      const pub = makePublicClient();

      const result = await client.createOffer(
        {
          collection: "0x2222222222222222222222222222222222222222",
          amountWei: "10000",
          currency: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
        },
        wallet,
        pub,
        { protocolFeeBps: 33, protocolFeeRecipient: "0x0000000000000000000000000000000000000001" },
      );

      expect(result.order.consideration[0].itemType).toBe(ItemType.ERC721_WITH_CRITERIA);
      expect(result.order.consideration[0].identifierOrCriteria).toBe("0");
    });
  });

  describe("acceptOpenOffer", () => {
    it("requires tokenId for collection offers", async () => {
      const wallet = makeWallet("0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
      const pub = makePublicClient();
      const order = makeBaseOfferOrder({ assetScope: "collection", identifierOrCriteria: "0" });

      await expect(client.acceptOpenOffer(order, wallet, pub)).rejects.toThrow(
        "acceptOpenOffer() requires tokenId when accepting collection or criteria offers",
      );
    });

    it("requires criteriaProof for criteria offers", async () => {
      const wallet = makeWallet("0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
      const pub = makePublicClient();
      const order = makeBaseOfferOrder({
        assetScope: "criteria",
        identifierOrCriteria: "12345",
        orderJson: {
          ...makeBaseOfferOrder().orderJson,
          consideration: [
            {
              itemType: ItemType.ERC721_WITH_CRITERIA,
              token: "0x2222222222222222222222222222222222222222",
              identifierOrCriteria: "12345",
              startAmount: "1",
              endAmount: "1",
              recipient: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            },
            {
              itemType: ItemType.ERC20,
              token: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
              identifierOrCriteria: "0",
              startAmount: "33",
              endAmount: "33",
              recipient: "0x0000000000000000000000000000000000000001",
            },
          ],
        },
      });

      await expect(client.acceptOpenOffer(order, wallet, pub, { tokenId: "77" })).rejects.toThrow(
        "acceptOpenOffer() requires criteriaProof for criteria-based offers",
      );
    });

    it("calls matchAdvancedOrders with mirror order, resolver, and canonical fulfillments", async () => {
      const wallet = makeWallet("0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
      const pub = makePublicClient(9n);
      const order = makeBaseOfferOrder();

      const txHash = await client.acceptOpenOffer(order, wallet, pub, { tokenId: "77" });

      expect(txHash).toBe("0xtxhash");
      expect(wallet.writeContract).toHaveBeenCalledTimes(1);
      const call = wallet.writeContract.mock.calls[0][0];
      expect(call.functionName).toBe("matchAdvancedOrders");
      expect(call.args[0]).toHaveLength(2);
      expect(call.args[1]).toEqual([
        {
          orderIndex: 0n,
          side: 1,
          index: 0n,
          identifier: 77n,
          criteriaProof: [],
        },
      ]);
      expect(call.args[2]).toEqual([
        {
          offerComponents: [{ orderIndex: 1n, itemIndex: 0n }],
          considerationComponents: [{ orderIndex: 0n, itemIndex: 0n }],
        },
        {
          offerComponents: [{ orderIndex: 0n, itemIndex: 0n }],
          considerationComponents: [{ orderIndex: 1n, itemIndex: 0n }],
        },
        {
          offerComponents: [{ orderIndex: 0n, itemIndex: 0n }],
          considerationComponents: [{ orderIndex: 0n, itemIndex: 1n }],
        },
      ]);

      const mirrorOrder = call.args[0][1];
      expect(mirrorOrder.parameters.offer[0].itemType).toBe(ItemType.ERC721);
      expect(mirrorOrder.parameters.offer[0].identifierOrCriteria).toBe(77n);
      expect(mirrorOrder.parameters.consideration[0].recipient).toBe("0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
      expect(mirrorOrder.parameters.consideration[0].startAmount).toBe(9967n);
    });
  });
});
