import { describe, it, expect, vi, beforeEach } from "vitest";
import { ApiClient, OobApiError } from "../api.js";

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

describe("ApiClient", () => {
  let api: ApiClient;

  beforeEach(() => {
    mockFetch.mockReset();
    api = new ApiClient({ chainId: 8453 });
  });

  describe("getOrders", () => {
    it("sends correct query params", async () => {
      mockFetch.mockResolvedValue(
        new Response(JSON.stringify({ orders: [], total: 0 }), { status: 200 }),
      );

      await api.getOrders({
        collection: "0xabc",
        type: "listing",
        sortBy: "price_asc",
        limit: 10,
        offset: 5,
      });

      expect(mockFetch).toHaveBeenCalledOnce();
      const url = new URL(mockFetch.mock.calls[0][0]);
      expect(url.pathname).toBe("/v1/orders");
      expect(url.searchParams.get("chainId")).toBe("8453");
      expect(url.searchParams.get("collection")).toBe("0xabc");
      expect(url.searchParams.get("type")).toBe("listing");
      expect(url.searchParams.get("sortBy")).toBe("price_asc");
      expect(url.searchParams.get("limit")).toBe("10");
      expect(url.searchParams.get("offset")).toBe("5");
    });

    it("defaults chainId from config", async () => {
      mockFetch.mockResolvedValue(
        new Response(JSON.stringify({ orders: [], total: 0 }), { status: 200 }),
      );

      await api.getOrders();

      const url = new URL(mockFetch.mock.calls[0][0]);
      expect(url.searchParams.get("chainId")).toBe("8453");
    });

    it("parses response correctly", async () => {
      const mockOrders = [{ orderHash: "0x123", chainId: 8453 }];
      mockFetch.mockResolvedValue(
        new Response(JSON.stringify({ orders: mockOrders, total: 1 }), { status: 200 }),
      );

      const result = await api.getOrders();
      expect(result.orders).toEqual(mockOrders);
      expect(result.total).toBe(1);
    });
  });

  describe("getOrder", () => {
    it("fetches by hash", async () => {
      mockFetch.mockResolvedValue(
        new Response(JSON.stringify({ order: { orderHash: "0xabc" } }), { status: 200 }),
      );

      const result = await api.getOrder("0xabc");
      const url = new URL(mockFetch.mock.calls[0][0]);
      expect(url.pathname).toBe("/v1/orders/0xabc");
      expect(result.order).toBeDefined();
    });
  });

  describe("getBestListing", () => {
    it("sends collection and chainId", async () => {
      mockFetch.mockResolvedValue(
        new Response(JSON.stringify({ order: null }), { status: 200 }),
      );

      await api.getBestListing({ collection: "0xnft" });

      const url = new URL(mockFetch.mock.calls[0][0]);
      expect(url.pathname).toBe("/v1/orders/best-listing");
      expect(url.searchParams.get("chainId")).toBe("8453");
      expect(url.searchParams.get("collection")).toBe("0xnft");
    });

    it("includes tokenId when provided", async () => {
      mockFetch.mockResolvedValue(
        new Response(JSON.stringify({ order: null }), { status: 200 }),
      );

      await api.getBestListing({ collection: "0xnft", tokenId: "42" });

      const url = new URL(mockFetch.mock.calls[0][0]);
      expect(url.searchParams.get("tokenId")).toBe("42");
    });
  });

  describe("getBestOffer", () => {
    it("sends correct path", async () => {
      mockFetch.mockResolvedValue(
        new Response(JSON.stringify({ order: null }), { status: 200 }),
      );

      await api.getBestOffer({ collection: "0xnft" });

      const url = new URL(mockFetch.mock.calls[0][0]);
      expect(url.pathname).toBe("/v1/orders/best-offer");
    });
  });

  describe("getCollectionStats", () => {
    it("lowercases collection address", async () => {
      mockFetch.mockResolvedValue(
        new Response(
          JSON.stringify({
            collection: "0xabc",
            chainId: 8453,
            listingCount: 5,
            floorPriceWei: "100",
            offerCount: 2,
            bestOfferWei: "50",
          }),
          { status: 200 },
        ),
      );

      await api.getCollectionStats("0xABC");

      const url = new URL(mockFetch.mock.calls[0][0]);
      expect(url.pathname).toBe("/v1/collections/0xabc/stats");
    });
  });

  describe("submitOrder", () => {
    it("sends POST with correct body", async () => {
      mockFetch.mockResolvedValue(
        new Response(JSON.stringify({ orderHash: "0xhash", status: "active" }), { status: 201 }),
      );

      const order = {
        offerer: "0x1234",
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

      await api.submitOrder(order, "0xsig");

      expect(mockFetch.mock.calls[0][1].method).toBe("POST");
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.chainId).toBe(8453);
      expect(body.order).toEqual(order);
      expect(body.signature).toBe("0xsig");
      expect(body.metadata).toBeUndefined();
    });

    it("sends explicit submission metadata when provided", async () => {
      mockFetch.mockResolvedValue(
        new Response(JSON.stringify({ orderHash: "0xhash", status: "active" }), { status: 201 }),
      );

      const order = {
        offerer: "0x1234",
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

      await api.submitOrder(order, "0xsig", {
        metadata: {
          originFees: [{ recipient: "0x2222222222222222222222222222222222222222", bps: 100 }],
          royaltyRecipient: "0x3333333333333333333333333333333333333333",
          royaltyBps: 500,
        },
      });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.metadata).toEqual({
        originFees: [{ recipient: "0x2222222222222222222222222222222222222222", bps: 100 }],
        royaltyRecipient: "0x3333333333333333333333333333333333333333",
        royaltyBps: 500,
      });
    });
  });

  describe("cancelOrder", () => {
    it("sends DELETE with signature", async () => {
      mockFetch.mockResolvedValue(
        new Response(JSON.stringify({ orderHash: "0xhash", status: "cancelled" }), { status: 200 }),
      );

      await api.cancelOrder("0xhash", "0xsig123");

      expect(mockFetch.mock.calls[0][1].method).toBe("DELETE");
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.signature).toBe("0xsig123");
    });
  });

  describe("API key header", () => {
    it("includes X-API-Key when configured", async () => {
      const apiWithKey = new ApiClient({ chainId: 8453, apiKey: "test-key" });
      mockFetch.mockResolvedValue(
        new Response(JSON.stringify({ orders: [], total: 0 }), { status: 200 }),
      );

      await apiWithKey.getOrders();

      const headers = mockFetch.mock.calls[0][1].headers;
      expect(headers["X-API-Key"]).toBe("test-key");
    });

    it("omits X-API-Key when not configured", async () => {
      mockFetch.mockResolvedValue(
        new Response(JSON.stringify({ orders: [], total: 0 }), { status: 200 }),
      );

      await api.getOrders();

      const headers = mockFetch.mock.calls[0][1].headers;
      expect(headers["X-API-Key"]).toBeUndefined();
    });
  });

  describe("Error handling", () => {
    it("throws OobApiError on non-2xx response", async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "Not found" }), { status: 404 }),
      );

      try {
        await api.getOrder("0xbad");
        expect.unreachable("Should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(OobApiError);
        expect((err as OobApiError).status).toBe(404);
        expect((err as OobApiError).message).toBe("Not found");
      }
    });

    it("OobApiError includes status code", async () => {
      mockFetch.mockResolvedValue(
        new Response(JSON.stringify({ error: "Forbidden" }), { status: 403 }),
      );

      try {
        await api.getOrders();
        expect.unreachable("Should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(OobApiError);
        expect((err as OobApiError).status).toBe(403);
      }
    });

    it("handles non-JSON error responses", async () => {
      mockFetch.mockResolvedValue(
        new Response("Internal Server Error", { status: 500 }),
      );

      // Retries 3 times with backoff before throwing
      await expect(api.getOrders()).rejects.toThrow(OobApiError);
    }, 15000);
  });

  describe("Custom API URL", () => {
    it("uses custom apiUrl", async () => {
      const customApi = new ApiClient({ chainId: 1, apiUrl: "https://custom.api.com/" });
      mockFetch.mockResolvedValue(
        new Response(JSON.stringify({ orders: [], total: 0 }), { status: 200 }),
      );

      await customApi.getOrders();

      const url = new URL(mockFetch.mock.calls[0][0]);
      expect(url.origin).toBe("https://custom.api.com");
    });

    it("strips trailing slash from apiUrl", async () => {
      const customApi = new ApiClient({ chainId: 1, apiUrl: "https://custom.api.com/" });
      mockFetch.mockResolvedValue(
        new Response(JSON.stringify({ orders: [], total: 0 }), { status: 200 }),
      );

      await customApi.getOrders();

      // Should not have double slash
      expect(mockFetch.mock.calls[0][0]).not.toContain("//v1");
    });
  });
});
