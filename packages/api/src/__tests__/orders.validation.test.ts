import { describe, it, expect } from "vitest";
import {
  handleGetOrder,
  handleCancelOrder,
  handleFillTx,
  handleBatchFillTx,
  handleBestListingFillTx,
  handleBatchSubmitOrders,
  handleBatchCancelOrders,
} from "../routes/orders.js";
import type { RouteContext } from "../types.js";

function makeCtx(url: string, method: string, body?: unknown, headers?: Record<string, string>): RouteContext {
  const request = new Request(url, {
    method,
    ...(body !== undefined
      ? {
          body: JSON.stringify(body),
          headers: { "content-type": "application/json", ...(headers ?? {}) },
        }
      : headers !== undefined
        ? { headers }
        : {}),
  });

  const parsed = new URL(url);
  return {
    request,
    env: {} as any,
    url: parsed,
    segments: parsed.pathname.split("/").filter(Boolean),
    params: parsed.searchParams,
  };
}

async function readJson(response: Response): Promise<any> {
  const text = await response.text();
  return text ? JSON.parse(text) : {};
}

describe("orders route validation regressions", () => {
  it("rejects non-32-byte hash in GET /v1/orders/:hash", async () => {
    const ctx = makeCtx("https://oob.test/v1/orders/0x1234", "GET");

    const res = await handleGetOrder(ctx);
    const json = await readJson(res);

    expect(res.status).toBe(400);
    expect(json.error).toBe("Invalid order hash format");
  });

  it("rejects non-32-byte hash in DELETE /v1/orders/:hash", async () => {
    const ctx = makeCtx("https://oob.test/v1/orders/0x1234", "DELETE", {
      signature: "0xdeadbeef",
    });

    const res = await handleCancelOrder(ctx);
    const json = await readJson(res);

    expect(res.status).toBe(400);
    expect(json.error).toBe("Invalid order hash format");
  });

  it("rejects non-32-byte hash in GET /v1/orders/:hash/fill-tx", async () => {
    const ctx = makeCtx(
      "https://oob.test/v1/orders/0x1234/fill-tx?buyer=0x1111111111111111111111111111111111111111",
      "GET",
    );

    const res = await handleFillTx(ctx);
    const json = await readJson(res);

    expect(res.status).toBe(400);
    expect(json.error).toBe("Invalid order hash format");
  });

  it("requires tipRecipient and tipBps together in fill-tx", async () => {
    const hash = `0x${"a".repeat(64)}`;
    const ctx = makeCtx(
      `https://oob.test/v1/orders/${hash}/fill-tx?buyer=0x1111111111111111111111111111111111111111&tipRecipient=0x2222222222222222222222222222222222222222`,
      "GET",
    );

    const res = await handleFillTx(ctx);
    const json = await readJson(res);

    expect(res.status).toBe(400);
    expect(json.error).toBe("tipRecipient and tipBps must be provided together");
  });

  it("requires tipRecipient and tipBps together in best-listing/fill-tx", async () => {
    const ctx = makeCtx(
      "https://oob.test/v1/orders/best-listing/fill-tx?chainId=8453&collection=0x3333333333333333333333333333333333333333&buyer=0x1111111111111111111111111111111111111111&tipBps=100",
      "GET",
    );

    const res = await handleBestListingFillTx(ctx);
    const json = await readJson(res);

    expect(res.status).toBe(400);
    expect(json.error).toBe("tipRecipient and tipBps must be provided together");
  });

  it("requires tipRecipient and tipBps together in batch fill-tx", async () => {
    const ctx = makeCtx("https://oob.test/v1/orders/batch/fill-tx", "POST", {
      buyer: "0x1111111111111111111111111111111111111111",
      orderHashes: [`0x${"b".repeat(64)}`],
      tipRecipient: "0x2222222222222222222222222222222222222222",
    });

    const res = await handleBatchFillTx(ctx);
    const json = await readJson(res);

    expect(res.status).toBe(400);
    expect(json.error).toBe("tipRecipient and tipBps must be provided together");
  });

  it("rejects invalid order hash entries in batch fill-tx", async () => {
    const ctx = makeCtx("https://oob.test/v1/orders/batch/fill-tx", "POST", {
      buyer: "0x1111111111111111111111111111111111111111",
      orderHashes: ["0x1234"],
    });

    const res = await handleBatchFillTx(ctx);
    const json = await readJson(res);

    expect(res.status).toBe(400);
    expect(json.error).toContain("Invalid order hash in array");
  });

  it("caps public batch fill-tx requests more aggressively than registered ones", async () => {
    const ctx = makeCtx("https://oob.test/v1/orders/batch/fill-tx", "POST", {
      buyer: "0x1111111111111111111111111111111111111111",
      orderHashes: Array.from({ length: 6 }, (_, i) => `0x${String(i + 1).padStart(64, "a")}`),
    });

    const res = await handleBatchFillTx(ctx);
    const json = await readJson(res);

    expect(res.status).toBe(400);
    expect(json.error).toBe("Batch size exceeds maximum (2)");
  });

  it("caps public batch submit requests more aggressively than registered ones", async () => {
    const ctx = makeCtx("https://oob.test/v1/orders/batch", "POST", {
      orders: Array.from({ length: 6 }, () => ({ chainId: 8453, order: {}, signature: "0xdeadbeef" })),
    });

    const res = await handleBatchSubmitOrders(ctx);
    const json = await readJson(res);

    expect(res.status).toBe(400);
    expect(json.error).toBe("Batch size exceeds maximum (2)");
  });

  it("caps public batch cancel requests more aggressively than registered ones", async () => {
    const ctx = makeCtx("https://oob.test/v1/orders/batch", "DELETE", {
      cancellations: Array.from({ length: 6 }, (_, i) => ({
        orderHash: `0x${String(i + 1).padStart(64, "b")}`,
        signature: "0xdeadbeef",
      })),
    });

    const res = await handleBatchCancelOrders(ctx);
    const json = await readJson(res);

    expect(res.status).toBe(400);
    expect(json.error).toBe("Batch size exceeds maximum (2)");
  });
});
