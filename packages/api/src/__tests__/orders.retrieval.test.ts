import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RouteContext } from "../types.js";

const mockSql = vi.fn();
const mockCacheGetOrSet = vi.fn();

vi.mock("../db.js", () => ({
  getPooledSqlClient: vi.fn(() => mockSql),
}));

vi.mock("../cache.js", () => ({
  RedisCache: vi.fn(() => ({
    getOrSet: mockCacheGetOrSet,
  })),
  CacheKeys: {
    collectionStats: vi.fn(() => "stats-key"),
  },
  getCacheConfig: vi.fn(() => ({ ttl: 30, keyPrefix: "test" })),
  hashQueryParams: vi.fn(() => "hash"),
}));

import {
  handleBestOffer,
  handleCollectionStats,
  handleGetOrders,
} from "../routes/orders.js";

const COLLECTION = "0x4444444444444444444444444444444444444444";
const OFFERER = "0x1111111111111111111111111111111111111111";
const PROTOCOL = "0x0000000000000000000000000000000000000001";
const WETH = "0x4200000000000000000000000000000000000006";

function makeOrderRow(overrides: Record<string, any> = {}) {
  return {
    order_hash: `0x${"a".repeat(64)}`,
    chain_id: 8453,
    order_type: "offer",
    offerer: OFFERER,
    nft_contract: COLLECTION,
    token_id: "42",
    asset_scope: "token",
    identifier_or_criteria: "42",
    token_standard: "ERC721",
    price_wei: "1000000000000000000",
    currency: WETH,
    protocol_fee_recipient: PROTOCOL,
    protocol_fee_bps: 33,
    origin_fees_json: [],
    origin_fee_bps: 0,
    royalty_recipient: null,
    royalty_bps: 0,
    start_time: "1",
    end_time: String(Math.floor(Date.now() / 1000) + 3600),
    status: "active",
    created_at: "2026-03-08T00:00:00.000Z",
    filled_tx_hash: null,
    filled_at: null,
    cancelled_tx_hash: null,
    cancelled_at: null,
    order_json: { offer: [], consideration: [] },
    signature: "0xsig",
    ...overrides,
  };
}

function makeCtx(url: string): RouteContext {
  const parsed = new URL(url);
  return {
    request: new Request(url),
    env: { DATABASE_URL: "postgres://test", PROTOCOL_FEE_RECIPIENT: PROTOCOL } as any,
    url: parsed,
    segments: parsed.pathname.split("/").filter(Boolean),
    params: parsed.searchParams,
  };
}

async function readJson(response: Response): Promise<any> {
  return JSON.parse(await response.text());
}

describe("orders retrieval semantics", () => {
  beforeEach(() => {
    mockSql.mockReset();
    mockCacheGetOrSet.mockReset();
    mockCacheGetOrSet.mockImplementation(async (_key: string, fetcher: () => Promise<unknown>) => fetcher());
  });

  describe("GET /v1/orders", () => {
    it("returns token-scoped and collection-wide offers for token offer queries, but not arbitrary criteria offers", async () => {
      mockSql
        .mockResolvedValueOnce([
          makeOrderRow({
            order_hash: `0x${"1".repeat(64)}`,
            token_id: "42",
            asset_scope: "token",
            identifier_or_criteria: "42",
            price_wei: "110",
          }),
          makeOrderRow({
            order_hash: `0x${"2".repeat(64)}`,
            token_id: "0",
            asset_scope: "collection",
            identifier_or_criteria: "0",
            price_wei: "100",
          }),
        ])
        .mockResolvedValueOnce([{ total: 2 }]);

      const res = await handleGetOrders(
        makeCtx(`https://oob.test/v1/orders?chainId=8453&collection=${COLLECTION}&tokenId=42&type=offer`),
      );
      const body = await readJson(res);

      expect(res.status).toBe(200);
      expect(body.orders).toHaveLength(2);
      expect(body.orders.map((order: any) => order.assetScope)).toEqual(["token", "collection"]);
      expect(body.orders.map((order: any) => order.identifierOrCriteria)).toEqual(["42", "0"]);
      expect(body.total).toBe(2);

      expect(mockSql).toHaveBeenCalledTimes(2);
      expect(String(mockSql.mock.calls[0][0])).toContain("asset_scope = 'token'");
      expect(String(mockSql.mock.calls[0][0])).toContain("OR asset_scope = 'collection'");
      expect(String(mockSql.mock.calls[0][0])).not.toContain("asset_scope = 'criteria'");
    });

    it("returns collection and criteria offers for collection-level offer queries without token filtering", async () => {
      mockSql
        .mockResolvedValueOnce([
          makeOrderRow({
            order_hash: `0x${"3".repeat(64)}`,
            token_id: "0",
            asset_scope: "collection",
            identifier_or_criteria: "0",
            price_wei: "100",
          }),
          makeOrderRow({
            order_hash: `0x${"4".repeat(64)}`,
            token_id: "0",
            asset_scope: "criteria",
            identifier_or_criteria: "123456789",
            price_wei: "99",
          }),
        ])
        .mockResolvedValueOnce([{ total: 2 }]);

      const res = await handleGetOrders(
        makeCtx(`https://oob.test/v1/orders?chainId=8453&collection=${COLLECTION}&type=offer`),
      );
      const body = await readJson(res);

      expect(res.status).toBe(200);
      expect(body.orders).toHaveLength(2);
      expect(body.orders.map((order: any) => order.assetScope)).toEqual(["collection", "criteria"]);
      expect(body.orders.map((order: any) => order.identifierOrCriteria)).toEqual(["0", "123456789"]);
    });
  });

  describe("GET /v1/orders/best-offer", () => {
    it("for token lookups, can return token-scoped or collection-wide offers but not criteria-root offers", async () => {
      mockSql.mockResolvedValueOnce([
        makeOrderRow({
          order_hash: `0x${"5".repeat(64)}`,
          token_id: "0",
          asset_scope: "collection",
          identifier_or_criteria: "0",
          price_wei: "125",
        }),
      ]);

      const res = await handleBestOffer(
        makeCtx(`https://oob.test/v1/orders/best-offer?chainId=8453&collection=${COLLECTION}&tokenId=42`),
      );
      const body = await readJson(res);

      expect(res.status).toBe(200);
      expect(body.order).toBeTruthy();
      expect(body.order.assetScope).toBe("collection");
      expect(body.order.identifierOrCriteria).toBe("0");

      expect(mockSql).toHaveBeenCalledTimes(1);
      const queryText = mockSql.mock.calls[0][0].join("");
      expect(queryText).toContain("(asset_scope = 'token' AND token_id = ");
      expect(queryText).toContain("OR asset_scope = 'collection'");
      expect(queryText).not.toContain("asset_scope = 'criteria'");
    });

    it("for collection lookups, can return criteria offers as the best offer", async () => {
      mockSql.mockResolvedValueOnce([
        makeOrderRow({
          order_hash: `0x${"6".repeat(64)}`,
          token_id: "0",
          asset_scope: "criteria",
          identifier_or_criteria: "987654321",
          price_wei: "150",
        }),
      ]);

      const res = await handleBestOffer(
        makeCtx(`https://oob.test/v1/orders/best-offer?chainId=8453&collection=${COLLECTION}`),
      );
      const body = await readJson(res);

      expect(res.status).toBe(200);
      expect(body.order.assetScope).toBe("criteria");
      expect(body.order.identifierOrCriteria).toBe("987654321");
    });
  });

  describe("GET /v1/collections/:address/stats", () => {
    it("counts all active collection offers, including criteria offers, in collection stats", async () => {
      mockCacheGetOrSet.mockImplementationOnce(async (_key: string, fetcher: () => Promise<unknown>) => fetcher());
      mockSql
        .mockResolvedValueOnce([{ listing_count: "1", floor_price_wei: "200" }])
        .mockResolvedValueOnce([{ offer_count: "3", best_offer_wei: "150" }]);

      const res = await handleCollectionStats(
        makeCtx(`https://oob.test/v1/collections/${COLLECTION}/stats?chainId=8453`),
      );
      const body = await readJson(res);

      expect(res.status).toBe(200);
      expect(body.collection).toBe(COLLECTION);
      expect(body.listingCount).toBe(1);
      expect(body.floorPriceWei).toBe("200");
      expect(body.offerCount).toBe(3);
      expect(body.bestOfferWei).toBe("150");

      expect(mockSql).toHaveBeenCalledTimes(2);
      const listingQuery = mockSql.mock.calls[0][0].join("");
      const offerQuery = mockSql.mock.calls[1][0].join("");
      expect(listingQuery).toContain("order_type = 'listing'");
      expect(offerQuery).toContain("order_type = 'offer'");
      expect(offerQuery).not.toContain("asset_scope");
    });
  });
});
