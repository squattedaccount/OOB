import { describe, it, expect } from "vitest";
import {
  buildSessionToken,
  createApiKeyForProject,
  createProjectForAccount,
  generateApiKey,
  getDefaultAnonymousEntitlements,
  hashApiKey,
  isTxHashFormat,
  normalizeAddress,
  shouldEnforceMonthlyQuota,
  slugifyProjectName,
  verifyPaymentForProject,
  verifySessionToken,
} from "../subscriptions.js";

function makeMockSql(options: {
  paymentByTxHash?: Record<string, any>;
  paymentByQuoteId?: Record<string, any>;
}) {
  return async (strings: TemplateStringsArray, ...values: any[]) => {
    const query = strings.join(" ");

    if (query.includes("WHERE p.tx_hash =") && query.includes("p.status = 'confirmed'")) {
      const txHash = values[0] as string;
      const row = options.paymentByTxHash?.[txHash];
      return row ? [row] : [];
    }

    if (query.includes("WHERE p.quote_id =") && query.includes("p.status = 'confirmed'")) {
      const quoteId = values[0] as string;
      const row = options.paymentByQuoteId?.[quoteId];
      return row ? [row] : [];
    }

    throw new Error(`Unexpected SQL in test: ${query}`);
  };
}

describe("subscription primitives", () => {
  it("normalizes wallet addresses to lowercase", () => {
    expect(normalizeAddress("0xAbCdEf1234567890abcdef1234567890ABCDEF12")).toBe(
      "0xabcdef1234567890abcdef1234567890abcdef12",
    );
  });

  it("slugifies project names safely", () => {
    expect(slugifyProjectName(" My First Project! ")).toBe("my-first-project");
  });

  it("generates API keys with stable prefix + hash", () => {
    const generated = generateApiKey();
    expect(generated.rawKey.startsWith("oob_live_")).toBe(true);
    expect(generated.keyPrefix.startsWith("oob_live_")).toBe(true);
    expect(generated.keyHash).toBe(hashApiKey(generated.rawKey));
    expect(generated.rawKey.includes(".")).toBe(true);
  });

  it("builds and verifies session tokens", () => {
    const token = buildSessionToken(
      {
        accountId: "acc_123",
        walletAddress: "0x1111111111111111111111111111111111111111",
        exp: Math.floor(Date.now() / 1000) + 3600,
      },
      "test-secret",
    );

    const payload = verifySessionToken(token, "test-secret");
    expect(payload).not.toBeNull();
    expect(payload?.accountId).toBe("acc_123");
  });

  it("rejects tampered session tokens", () => {
    const token = buildSessionToken(
      {
        accountId: "acc_123",
        walletAddress: "0x1111111111111111111111111111111111111111",
        exp: Math.floor(Date.now() / 1000) + 3600,
      },
      "test-secret",
    );

    const tampered = `${token}x`;
    expect(verifySessionToken(tampered, "test-secret")).toBeNull();
  });

  it("rejects expired session tokens", () => {
    const token = buildSessionToken(
      {
        accountId: "acc_123",
        walletAddress: "0x1111111111111111111111111111111111111111",
        exp: Math.floor(Date.now() / 1000) - 1,
      },
      "test-secret",
    );

    expect(verifySessionToken(token, "test-secret")).toBeNull();
  });

  it("validates payment transaction hash format strictly", () => {
    expect(isTxHashFormat(`0x${"ab".repeat(32)}`)).toBe(true);
    expect(isTxHashFormat("0x1234")).toBe(false);
    expect(isTxHashFormat(`0x${"AB".repeat(32)}`)).toBe(false);
  });

  it("detects when monthly quota enforcement should apply", () => {
    expect(shouldEnforceMonthlyQuota({ monthlyRequests: 25000 })).toBe(true);
    expect(shouldEnforceMonthlyQuota({ monthlyRequests: 0 })).toBe(false);
    expect(shouldEnforceMonthlyQuota({})).toBe(false);
  });

  it("exposes the agreed anonymous public entitlements", () => {
    expect(getDefaultAnonymousEntitlements()).toEqual({
      readRpm: 15,
      writeRpm: 2,
      maxBatchSize: 2,
      maxApiKeys: 0,
      websocketEnabled: false,
      monthlyRequests: 5000,
    });
  });

  it("creates projects without implicitly attaching a free subscription", async () => {
    const calls: string[] = [];
    const sql = async (strings: TemplateStringsArray) => {
      const query = strings.join(" ");
      calls.push(query);
      return [{
        id: "proj_1",
        account_id: "acc_1",
        name: "Starter App",
        slug: "starter-app",
        status: "active",
        created_at: "2026-03-08T00:00:00.000Z",
      }];
    };

    const project = await createProjectForAccount(sql as any, "acc_1", "Starter App");

    expect(project.id).toBe("proj_1");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("INSERT INTO api_projects");
    expect(calls[0]).not.toContain("api_project_subscriptions");
    expect(calls[0]).not.toContain("code = 'free'");
  });

  it("requires an active paid subscription before creating API keys", async () => {
    const sql = async (strings: TemplateStringsArray) => {
      const query = strings.join(" ");
      if (query.includes("SELECT p.id, pl.code AS plan_code")) {
        return [];
      }
      throw new Error(`Unexpected SQL in test: ${query}`);
    };

    await expect(
      createApiKeyForProject(sql as any, "acc_1", "proj_1", "Primary Key"),
    ).rejects.toThrow("Active paid subscription required before creating API keys");
  });

  it("returns existing confirmed payment when the tx hash was already consumed", async () => {
    const txHash = `0x${"ab".repeat(32)}`;
    const sql = makeMockSql({
      paymentByTxHash: {
        [txHash]: {
          payment_id: "pay_1",
          subscription_id: "sub_1",
          project_id: "proj_1",
          status: "active",
          current_period_end: "2026-04-01T00:00:00.000Z",
        },
      },
    });

    const result = await verifyPaymentForProject(
      sql as any,
      {} as any,
      "acc_1",
      "proj_1",
      "0x1111111111111111111111111111111111111111",
      "quote_1",
      txHash,
    );

    expect(result).toEqual({
      paymentId: "pay_1",
      subscriptionId: "sub_1",
      projectId: "proj_1",
      status: "active",
      currentPeriodEnd: "2026-04-01T00:00:00.000Z",
    });
  });

  it("returns existing confirmed payment when the quote was already consumed", async () => {
    const txHash = `0x${"cd".repeat(32)}`;
    const sql = makeMockSql({
      paymentByQuoteId: {
        quote_1: {
          payment_id: "pay_2",
          subscription_id: "sub_2",
          project_id: "proj_1",
          status: "active",
          current_period_end: "2026-05-01T00:00:00.000Z",
        },
      },
    });

    const result = await verifyPaymentForProject(
      sql as any,
      {} as any,
      "acc_1",
      "proj_1",
      "0x1111111111111111111111111111111111111111",
      "quote_1",
      txHash,
    );

    expect(result).toEqual({
      paymentId: "pay_2",
      subscriptionId: "sub_2",
      projectId: "proj_1",
      status: "active",
      currentPeriodEnd: "2026-05-01T00:00:00.000Z",
    });
  });
});
