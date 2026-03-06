import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock viem before any imports that use it (seaport.ts calls parseAbi at module level)
vi.mock("viem", () => ({
  parseAbi: vi.fn(() => []),
  getAddress: vi.fn((addr: string) => addr),
  keccak256: vi.fn(() => "0x" + "0".repeat(64)),
  encodeAbiParameters: vi.fn(() => "0x"),
  parseAbiParameters: vi.fn(() => []),
}));

import { OpenOrderBook, NeedsApprovalError, InsufficientBalanceError } from "../client.js";
import { DEFAULT_API_URL, DEFAULT_ORIGIN_FEE_BPS, DEFAULT_ORIGIN_FEE_RECIPIENT, DEFAULT_ROYALTY_POLICY } from "../types.js";

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

describe("OpenOrderBook", () => {
  let oob: OpenOrderBook;

  beforeEach(() => {
    mockFetch.mockReset();
    oob = new OpenOrderBook({ chainId: 8453 });
  });

  describe("constructor", () => {
    it("sets default config values", () => {
      expect(oob.config.chainId).toBe(8453);
      expect(oob.config.apiUrl).toBe(DEFAULT_API_URL);
      expect(oob.config.originFeeBps).toBe(DEFAULT_ORIGIN_FEE_BPS);
      expect(oob.config.originFeeRecipient).toBe(DEFAULT_ORIGIN_FEE_RECIPIENT);
      expect(oob.config.royaltyPolicy).toBe(DEFAULT_ROYALTY_POLICY);
    });

    it("accepts custom config", () => {
      const custom = new OpenOrderBook({
        chainId: 1,
        apiUrl: "https://custom.api",
        apiKey: "my-key",
        originFeeBps: 100,
        originFeeRecipient: "0x1234567890123456789012345678901234567890",
      });
      expect(custom.config.chainId).toBe(1);
      expect(custom.config.apiUrl).toBe("https://custom.api");
      expect(custom.config.apiKey).toBe("my-key");
      expect(custom.config.originFeeBps).toBe(100);
      expect(custom.config.royaltyPolicy).toBe(DEFAULT_ROYALTY_POLICY);
    });

    it("exposes api and seaport sub-clients", () => {
      expect(oob.api).toBeDefined();
      expect(oob.seaport).toBeDefined();
    });
  });

  describe("read methods (no wallet)", () => {
    it("getOrders delegates to api", async () => {
      mockFetch.mockResolvedValue(
        new Response(JSON.stringify({ orders: [{ orderHash: "0x1" }], total: 1 }), { status: 200 }),
      );

      const result = await oob.getOrders({ collection: "0xnft", type: "listing" });
      expect(result.orders).toHaveLength(1);
      expect(result.total).toBe(1);
    });

    it("getOrder returns order or null", async () => {
      mockFetch.mockResolvedValue(
        new Response(JSON.stringify({ order: { orderHash: "0x1" } }), { status: 200 }),
      );

      const order = await oob.getOrder("0x1");
      expect(order).toBeDefined();
      expect(order!.orderHash).toBe("0x1");
    });

    it("getOrder returns null for missing order", async () => {
      mockFetch.mockResolvedValue(
        new Response(JSON.stringify({ order: null }), { status: 200 }),
      );

      const order = await oob.getOrder("0xmissing");
      expect(order).toBeNull();
    });

    it("getBestListing delegates correctly", async () => {
      mockFetch.mockResolvedValue(
        new Response(JSON.stringify({ order: { orderHash: "0xfloor" } }), { status: 200 }),
      );

      const order = await oob.getBestListing({ collection: "0xnft" });
      expect(order).toBeDefined();

      const url = new URL(mockFetch.mock.calls[0][0]);
      expect(url.pathname).toBe("/v1/orders/best-listing");
    });

    it("getBestOffer delegates correctly", async () => {
      mockFetch.mockResolvedValue(
        new Response(JSON.stringify({ order: null }), { status: 200 }),
      );

      const order = await oob.getBestOffer({ collection: "0xnft" });
      expect(order).toBeNull();
    });

    it("getListings uses correct defaults", async () => {
      mockFetch.mockResolvedValue(
        new Response(JSON.stringify({ orders: [], total: 0 }), { status: 200 }),
      );

      await oob.getListings("0xnft", { limit: 5 });

      const url = new URL(mockFetch.mock.calls[0][0]);
      expect(url.searchParams.get("type")).toBe("listing");
      expect(url.searchParams.get("status")).toBe("active");
      expect(url.searchParams.get("sortBy")).toBe("price_asc");
      expect(url.searchParams.get("limit")).toBe("5");
    });

    it("getOffers uses correct defaults", async () => {
      mockFetch.mockResolvedValue(
        new Response(JSON.stringify({ orders: [], total: 0 }), { status: 200 }),
      );

      await oob.getOffers("0xnft");

      const url = new URL(mockFetch.mock.calls[0][0]);
      expect(url.searchParams.get("type")).toBe("offer");
      expect(url.searchParams.get("sortBy")).toBe("price_desc");
    });

    it("getCollectionStats delegates correctly", async () => {
      mockFetch.mockResolvedValue(
        new Response(
          JSON.stringify({
            collection: "0xnft",
            chainId: 8453,
            listingCount: 10,
            floorPriceWei: "500000000000000000",
            offerCount: 3,
            bestOfferWei: "400000000000000000",
          }),
          { status: 200 },
        ),
      );

      const stats = await oob.getCollectionStats("0xNFT");
      expect(stats.listingCount).toBe(10);
      expect(stats.floorPriceWei).toBe("500000000000000000");
    });
  });

  describe("wallet requirement", () => {
    it("createListing throws without wallet", async () => {
      await expect(
        oob.createListing({
          collection: "0x1234567890123456789012345678901234567890",
          tokenId: "1",
          priceWei: "1000000000000000000",
        }),
      ).rejects.toThrow("Wallet not connected");
    });

    it("createOffer throws without wallet", async () => {
      await expect(
        oob.createOffer({
          collection: "0x1234567890123456789012345678901234567890",
          tokenId: "1",
          amountWei: "500000000000000000",
          currency: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
        }),
      ).rejects.toThrow("Wallet not connected");
    });

    it("fillOrder throws without wallet", async () => {
      await expect(oob.fillOrder("0xhash")).rejects.toThrow("Wallet not connected");
    });

    it("cancelOrder throws without wallet", async () => {
      await expect(oob.cancelOrder("0xhash")).rejects.toThrow("Wallet not connected");
    });

    it("approveCollection throws without wallet", async () => {
      await expect(oob.approveCollection("0xnft")).rejects.toThrow("Wallet not connected");
    });

    it("approveErc20 throws without wallet", async () => {
      await expect(oob.approveErc20("0xweth")).rejects.toThrow("Wallet not connected");
    });

    it("isApproved throws without public client", async () => {
      await expect(oob.isApproved("0xnft")).rejects.toThrow("Public client not connected");
    });

    it("isReadyToOffer throws without public client", async () => {
      await expect(
        oob.isReadyToOffer("0xweth", "1000"),
      ).rejects.toThrow("Public client not connected");
    });
  });

  describe("submitOrder (pre-signed)", () => {
    it("submits without requiring wallet", async () => {
      mockFetch.mockResolvedValue(
        new Response(JSON.stringify({ orderHash: "0xhash", status: "active" }), { status: 201 }),
      );

      const order = {
        offerer: "0x1234567890123456789012345678901234567890",
        zone: "0x0000000000000000000000000000000000000000",
        offer: [],
        consideration: [],
        orderType: 0 as const,
        startTime: "100",
        endTime: "200",
        zoneHash: "0x" + "0".repeat(64),
        salt: "1",
        conduitKey: "0x" + "0".repeat(64),
        counter: "0",
      };

      const result = await oob.submitOrder(order, "0xsig");
      expect(result.orderHash).toBe("0xhash");
      expect(result.status).toBe("active");
    });
  });

  describe("royalty policy", () => {
    const wallet = {
      account: { address: "0x1234567890123456789012345678901234567890" },
    } as any;

    const protocolConfig = {
      protocolFeeBps: 33,
      protocolFeeRecipient: "0x0000000000000000000000000000000000000001",
    };

    const baseListingParams = {
      collection: "0x1234567890123456789012345678901234567890",
      tokenId: "1",
      priceWei: "10000",
    };

    const baseOfferParams = {
      collection: "0x1234567890123456789012345678901234567890",
      tokenId: "1",
      amountWei: "10000",
      currency: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
    };

    function setupCreateListing(oobClient: OpenOrderBook, publicClientOverrides: Record<string, any> = {}) {
      const publicClient = {
        readContract: vi.fn(),
        ...publicClientOverrides,
      } as any;

      oobClient.connect(wallet, publicClient);
      vi.spyOn(oobClient.seaport, "isApprovedForAll").mockResolvedValue(true);
      vi.spyOn(oobClient.api, "getProtocolConfig").mockResolvedValue(protocolConfig);
      vi.spyOn(oobClient.seaport, "createListing").mockResolvedValue({
        order: { offerer: wallet.account.address, consideration: [], offer: [] } as any,
        signature: "0xsig" as any,
      });
      vi.spyOn(oobClient.api, "submitOrder").mockResolvedValue({ orderHash: "0xhash", status: "active" });
      return publicClient;
    }

    function setupCreateOffer(oobClient: OpenOrderBook, publicClientOverrides: Record<string, any> = {}) {
      const publicClient = {
        readContract: vi.fn(),
        ...publicClientOverrides,
      } as any;

      oobClient.connect(wallet, publicClient);
      vi.spyOn(oobClient.seaport, "checkErc20Readiness").mockResolvedValue({
        hasBalance: true,
        hasAllowance: true,
        balance: 10000n,
        allowance: 10000n,
      } as any);
      vi.spyOn(oobClient.api, "getProtocolConfig").mockResolvedValue(protocolConfig);
      vi.spyOn(oobClient.seaport, "createOffer").mockResolvedValue({
        order: { offerer: wallet.account.address, consideration: [], offer: [] } as any,
        signature: "0xsig" as any,
      });
      vi.spyOn(oobClient.api, "submitOrder").mockResolvedValue({ orderHash: "0xhash", status: "active" });
      return publicClient;
    }

    it("manual_only embeds explicitly provided listing royalty", async () => {
      const client = new OpenOrderBook({ chainId: 8453, royaltyPolicy: "manual_only" });
      setupCreateListing(client);

      await client.createListing({
        ...baseListingParams,
        royaltyRecipient: "0x2222222222222222222222222222222222222222",
        royaltyBps: 500,
      });

      expect(client.seaport.createListing).toHaveBeenCalledWith(
        expect.objectContaining({ royaltyRecipient: "0x2222222222222222222222222222222222222222", royaltyBps: 500 }),
        expect.anything(),
        expect.anything(),
        protocolConfig,
      );
      expect(client.api.submitOrder).toHaveBeenCalledWith(
        expect.anything(),
        "0xsig",
        expect.objectContaining({
          metadata: expect.objectContaining({ royaltyRecipient: "0x2222222222222222222222222222222222222222", royaltyBps: 500 }),
        }),
      );
    });

    it("manual_only accepts explicit royalty above the origin fee cap", async () => {
      const client = new OpenOrderBook({ chainId: 8453, royaltyPolicy: "manual_only" });
      setupCreateListing(client);

      await expect(client.createListing({
        ...baseListingParams,
        royaltyRecipient: "0x2222222222222222222222222222222222222222",
        royaltyBps: 750,
      })).resolves.toEqual({ orderHash: "0xhash", status: "active" });

      expect(client.seaport.createListing).toHaveBeenCalledWith(
        expect.objectContaining({ royaltyRecipient: "0x2222222222222222222222222222222222222222", royaltyBps: 750 }),
        expect.anything(),
        expect.anything(),
        protocolConfig,
      );
    });

    it("off strips explicitly provided listing royalty", async () => {
      const client = new OpenOrderBook({ chainId: 8453, royaltyPolicy: "off" });
      setupCreateListing(client);

      await client.createListing({
        ...baseListingParams,
        royaltyRecipient: "0x2222222222222222222222222222222222222222",
        royaltyBps: 500,
      });

      expect(client.seaport.createListing).toHaveBeenCalledWith(
        expect.not.objectContaining({ royaltyRecipient: "0x2222222222222222222222222222222222222222", royaltyBps: 500 }),
        expect.anything(),
        expect.anything(),
        protocolConfig,
      );
      expect(client.api.submitOrder).toHaveBeenCalledWith(
        expect.anything(),
        "0xsig",
        expect.objectContaining({ metadata: undefined }),
      );
    });

    it("auto_eip2981 resolves listing royalty from royaltyInfo", async () => {
      const client = new OpenOrderBook({ chainId: 8453, royaltyPolicy: "auto_eip2981" });
      const publicClient = setupCreateListing(client);
      publicClient.readContract.mockResolvedValue(["0x3333333333333333333333333333333333333333", 500n]);

      await client.createListing(baseListingParams);

      expect(publicClient.readContract).toHaveBeenCalled();
      expect(client.seaport.createListing).toHaveBeenCalledWith(
        expect.objectContaining({ royaltyRecipient: "0x3333333333333333333333333333333333333333", royaltyBps: 500 }),
        expect.anything(),
        expect.anything(),
        protocolConfig,
      );
    });

    it("auto_eip2981 skips lookup for collection offers and keeps no royalty", async () => {
      const client = new OpenOrderBook({ chainId: 8453, royaltyPolicy: "auto_eip2981" });
      const publicClient = setupCreateOffer(client);

      await client.createOffer({
        collection: baseOfferParams.collection,
        amountWei: baseOfferParams.amountWei,
        currency: baseOfferParams.currency,
      });

      expect(publicClient.readContract).not.toHaveBeenCalled();
      expect(client.seaport.createOffer).toHaveBeenCalledWith(
        expect.not.objectContaining({ royaltyBps: expect.anything(), royaltyRecipient: expect.anything() }),
        expect.anything(),
        expect.anything(),
        protocolConfig,
      );
    });

    it("explicit royalty takes precedence over auto_eip2981", async () => {
      const client = new OpenOrderBook({ chainId: 8453, royaltyPolicy: "auto_eip2981" });
      const publicClient = setupCreateOffer(client);

      await client.createOffer({
        ...baseOfferParams,
        royaltyRecipient: "0x4444444444444444444444444444444444444444",
        royaltyBps: 250,
      });

      expect(publicClient.readContract).not.toHaveBeenCalled();
      expect(client.seaport.createOffer).toHaveBeenCalledWith(
        expect.objectContaining({ royaltyRecipient: "0x4444444444444444444444444444444444444444", royaltyBps: 250 }),
        expect.anything(),
        expect.anything(),
        protocolConfig,
      );
    });
  });

  describe("custom errors", () => {
    it("NeedsApprovalError has correct properties", () => {
      const err = new NeedsApprovalError("collection", "0xnft", "Not approved");
      expect(err.name).toBe("NeedsApprovalError");
      expect(err.approvalType).toBe("collection");
      expect(err.tokenAddress).toBe("0xnft");
      expect(err.message).toBe("Not approved");
      expect(err).toBeInstanceOf(Error);
    });

    it("InsufficientBalanceError has correct properties", () => {
      const err = new InsufficientBalanceError("0xweth", 100n, 500n);
      expect(err.name).toBe("InsufficientBalanceError");
      expect(err.tokenAddress).toBe("0xweth");
      expect(err.balance).toBe(100n);
      expect(err.required).toBe(500n);
      expect(err.message).toContain("100");
      expect(err.message).toContain("500");
      expect(err).toBeInstanceOf(Error);
    });
  });

  describe("connect", () => {
    it("returns this for chaining", () => {
      const mockWallet = {} as any;
      const mockPublic = {} as any;
      const result = oob.connect(mockWallet, mockPublic);
      expect(result).toBe(oob);
    });
  });
});
