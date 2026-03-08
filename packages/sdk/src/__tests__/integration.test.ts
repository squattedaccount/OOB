import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("viem", () => ({
  parseAbi: vi.fn(() => []),
  getAddress: vi.fn((addr: string) => addr),
  keccak256: vi.fn(() => "0x" + "0".repeat(64)),
  encodeAbiParameters: vi.fn(() => "0x"),
  parseAbiParameters: vi.fn(() => []),
}));

import { OpenOrderBook } from "../client.js";
import { ItemType, OrderType, type OobOrder, type SeaportOrderComponents } from "../types.js";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function makeWallet(address = "0x1111111111111111111111111111111111111111") {
  return {
    account: { address },
    chain: { id: 8453 },
    signTypedData: vi.fn().mockResolvedValue("0xsigned-order"),
    signMessage: vi.fn().mockResolvedValue("0xsigned-message"),
    writeContract: vi.fn().mockResolvedValue("0xtxhash"),
  } as any;
}

function makePublicClient() {
  return {
    readContract: vi.fn(async ({ functionName }: { functionName: string }) => {
      if (functionName === "getCounter") return 7n;
      if (functionName === "balanceOf") return 1000000n;
      if (functionName === "allowance") return 1000000n;
      if (functionName === "isApprovedForAll") return true;
      return 0n;
    }),
  } as any;
}

function makeOpenOfferOrder(overrides: Partial<OobOrder> = {}): OobOrder {
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
        itemType: ItemType.ERC721,
        token: "0x2222222222222222222222222222222222222222",
        identifierOrCriteria: "42",
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
    orderHash: "0xopenoffer",
    chainId: 8453,
    orderType: "offer",
    offerer: orderJson.offerer,
    nftContract: "0x2222222222222222222222222222222222222222",
    tokenId: "42",
    assetScope: "token",
    identifierOrCriteria: "42",
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

describe("OpenOrderBook integration flows", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it("creates and submits an open token offer through the full SDK flow", async () => {
    const oob = new OpenOrderBook({ chainId: 8453 });
    const wallet = makeWallet();
    const publicClient = makePublicClient();
    oob.connect(wallet, publicClient);

    mockFetch
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ protocolFeeBps: 33, protocolFeeRecipient: "0x0000000000000000000000000000000000000001" }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ orderHash: "0xsubmitted", status: "active" }), { status: 201 }),
      );

    const result = await oob.createOffer({
      collection: "0x2222222222222222222222222222222222222222",
      tokenId: "42",
      amountWei: "10000",
      currency: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
    });

    expect(result).toEqual({ orderHash: "0xsubmitted", status: "active" });
    expect(mockFetch).toHaveBeenCalledTimes(2);
    const submitUrl = new URL(mockFetch.mock.calls[1][0]);
    expect(submitUrl.pathname).toBe("/v1/orders");
    const submitBody = JSON.parse(mockFetch.mock.calls[1][1].body);
    expect(submitBody.signature).toBe("0xsigned-order");
    expect(submitBody.order.offer[0].itemType).toBe(ItemType.ERC20);
    expect(submitBody.order.consideration[0].itemType).toBe(ItemType.ERC721);
    expect(submitBody.order.consideration[0].identifierOrCriteria).toBe("42");
  });

  it("routes open offers away from fillOrder and into acceptOpenOffer", async () => {
    const oob = new OpenOrderBook({ chainId: 8453 });
    const wallet = makeWallet("0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
    const publicClient = makePublicClient();
    oob.connect(wallet, publicClient);

    const order = makeOpenOfferOrder({
      orderJson: {
        ...makeOpenOfferOrder().orderJson,
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
      },
      assetScope: "collection",
      identifierOrCriteria: "0",
      tokenId: "0",
    });

    mockFetch.mockImplementation(() => Promise.resolve(
      new Response(JSON.stringify({ order }), { status: 200 }),
    ));

    await expect(oob.fillOrder(order.orderHash)).rejects.toThrow(
      "Use acceptOpenOffer() instead of fillOrder()",
    );

    const txHash = await oob.acceptOpenOffer(order.orderHash, { tokenId: "42" });
    expect(txHash).toBe("0xtxhash");
    expect(wallet.writeContract).toHaveBeenCalledTimes(1);
    const call = wallet.writeContract.mock.calls[0][0];
    expect(call.functionName).toBe("matchAdvancedOrders");
    expect(call.args[1]).toEqual([
      {
        orderIndex: 0n,
        side: 1,
        index: 0n,
        identifier: 42n,
        criteriaProof: [],
      },
    ]);
  });

  it("enforces criteria proofs on the public acceptOpenOffer flow", async () => {
    const oob = new OpenOrderBook({ chainId: 8453 });
    const wallet = makeWallet("0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
    const publicClient = makePublicClient();
    oob.connect(wallet, publicClient);

    const order = makeOpenOfferOrder({
      assetScope: "criteria",
      identifierOrCriteria: "12345",
      tokenId: "0",
      orderJson: {
        ...makeOpenOfferOrder().orderJson,
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

    mockFetch.mockImplementation(() => Promise.resolve(
      new Response(JSON.stringify({ order }), { status: 200 }),
    ));

    await expect(oob.acceptOpenOffer(order.orderHash, { tokenId: "42" })).rejects.toThrow(
      "acceptOpenOffer() requires criteriaProof for criteria-based offers",
    );

    const txHash = await oob.acceptOpenOffer(order.orderHash, {
      tokenId: "42",
      criteriaProof: ["0x" + "1".repeat(64)],
    });

    expect(txHash).toBe("0xtxhash");
    const call = wallet.writeContract.mock.calls[0][0];
    expect(call.args[1]).toEqual([
      {
        orderIndex: 0n,
        side: 1,
        index: 0n,
        identifier: 42n,
        criteriaProof: ["0x" + "1".repeat(64)],
      },
    ]);
  });
});
