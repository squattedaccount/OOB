import { createHash, randomBytes, createHmac, timingSafeEqual } from "node:crypto";
import { decodeEventLog, parseAbiItem, recoverMessageAddress } from "viem";
import type { Hex } from "viem";
import type { SqlClient } from "./db.js";
import { getPooledSqlClient } from "./db.js";
import type { Env, RequestApiAccess } from "./types.js";

const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;
const NONCE_TTL_SECONDS = 60 * 10;
const API_KEY_PREFIX = "oob_live_";
const ZERO_UUID = "00000000-0000-0000-0000-000000000000";
const ERC20_TRANSFER_EVENT = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
const DEFAULT_ANONYMOUS_ENTITLEMENTS = {
  readRpm: 15,
  writeRpm: 2,
  maxBatchSize: 2,
  maxApiKeys: 0,
  websocketEnabled: false,
  monthlyRequests: 5000,
};
const STARTER_PLAN_CODE = "starter";
const PRO_PLAN_CODE = "pro";

export interface SessionPayload {
  accountId: string;
  walletAddress: string;
  exp: number;
}

function getClientIp(request: Request): string {
  return (
    request.headers.get("CF-Connecting-IP") ||
    request.headers.get("X-Forwarded-For")?.split(",")[0]?.trim() ||
    "unknown"
  );
}

function isLegacyRegisteredApiKey(rawApiKey: string, env: Env): boolean {
  if (!env.API_KEYS) return false;
  const validKeys = env.API_KEYS.split(",").map((k) => k.trim()).filter(Boolean);
  return validKeys.includes(rawApiKey);
}

export async function resolveRequestApiAccess(request: Request, env: Env): Promise<RequestApiAccess> {
  const rawApiKey = request.headers.get("X-API-Key") || "";
  if (rawApiKey) {
    try {
      const sql = getPooledSqlClient(env);
      const resolved = await resolveApiKeyAccess(sql, rawApiKey);
      if (resolved) {
        return {
          identifier: `dbk:${resolved.apiKeyId}`,
          entitlements: resolved.entitlements,
          isRegistered: true,
          apiKeyId: resolved.apiKeyId,
          projectId: resolved.projectId,
          planCode: resolved.planCode,
        };
      }
    } catch {
      // Fall through to legacy/env-based behavior
    }

    if (isLegacyRegisteredApiKey(rawApiKey, env)) {
      return {
        identifier: `legacy:${rawApiKey}`,
        entitlements: getDefaultAnonymousEntitlements(),
        isRegistered: false,
        apiKeyId: null,
        projectId: null,
        planCode: "legacy_anonymous",
      };
    }
  }

  return {
    identifier: `ip:${getClientIp(request)}`,
    entitlements: getDefaultAnonymousEntitlements(),
    isRegistered: false,
    apiKeyId: null,
    projectId: null,
    planCode: "public",
  };
}

export interface ResolvedApiAccess {
  accountId: string;
  projectId: string;
  apiKeyId: string;
  planCode: string;
  entitlements: Record<string, unknown>;
}

interface RpcLog {
  address: string;
  topics: string[];
  data: string;
  logIndex?: string;
}

interface PaymentVerificationResult {
  paymentId: string;
  subscriptionId: string;
  projectId: string;
  status: string;
  currentPeriodEnd: string;
}

export function isTxHashFormat(txHash: string): boolean {
  return /^0x[0-9a-f]{64}$/.test(txHash);
}

function isUniqueViolation(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  return code === "23505";
}

async function getPaymentVerificationResultByTxHash(sql: SqlClient, txHash: string): Promise<PaymentVerificationResult | null> {
  const rows = await sql`
    SELECT
      p.id AS payment_id,
      p.project_id,
      COALESCE(s.id, p.subscription_id) AS subscription_id,
      COALESCE(s.status, p.status) AS status,
      COALESCE(s.current_period_end, p.confirmed_at) AS current_period_end
    FROM api_payments p
    LEFT JOIN api_project_subscriptions s ON s.id = p.subscription_id
    WHERE p.tx_hash = ${txHash}
      AND p.status = 'confirmed'
    LIMIT 1
  `;
  if (rows.length === 0) return null;
  return {
    paymentId: rows[0].payment_id as string,
    subscriptionId: rows[0].subscription_id as string,
    projectId: rows[0].project_id as string,
    status: rows[0].status as string,
    currentPeriodEnd: rows[0].current_period_end as string,
  };
}

async function getPaymentVerificationResultByQuoteId(sql: SqlClient, quoteId: string): Promise<PaymentVerificationResult | null> {
  const rows = await sql`
    SELECT
      p.id AS payment_id,
      p.project_id,
      COALESCE(s.id, p.subscription_id) AS subscription_id,
      COALESCE(s.status, p.status) AS status,
      COALESCE(s.current_period_end, p.confirmed_at) AS current_period_end
    FROM api_payments p
    LEFT JOIN api_project_subscriptions s ON s.id = p.subscription_id
    WHERE p.quote_id = ${quoteId}
      AND p.status = 'confirmed'
    LIMIT 1
  `;
  if (rows.length === 0) return null;
  return {
    paymentId: rows[0].payment_id as string,
    subscriptionId: rows[0].subscription_id as string,
    projectId: rows[0].project_id as string,
    status: rows[0].status as string,
    currentPeriodEnd: rows[0].current_period_end as string,
  };
}

export function normalizeAddress(address: string): string {
  return address.toLowerCase();
}

export function isValidWalletAddress(address: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(address);
}

export function slugifyProjectName(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "project";
}

export function hashApiKey(rawKey: string): string {
  return createHash("sha256").update(rawKey).digest("hex");
}

export function getDefaultAnonymousEntitlements(): Record<string, unknown> {
  return { ...DEFAULT_ANONYMOUS_ENTITLEMENTS };
}

export function getEntitlementNumber(entitlements: Record<string, unknown> | null | undefined, key: string, fallback: number): number {
  const value = Number(entitlements?.[key]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function getEntitlementBoolean(entitlements: Record<string, unknown> | null | undefined, key: string, fallback: boolean): boolean {
  const value = entitlements?.[key];
  if (typeof value === "boolean") return value;
  return fallback;
}

export function shouldEnforceMonthlyQuota(entitlements: Record<string, unknown> | null | undefined): boolean {
  return getEntitlementNumber(entitlements, "monthlyRequests", 0) > 0;
}

export async function isProjectMonthlyQuotaExceeded(
  sql: SqlClient,
  projectId: string,
  entitlements: Record<string, unknown> | null | undefined,
): Promise<boolean> {
  const monthlyLimit = getEntitlementNumber(entitlements, "monthlyRequests", 0);
  if (monthlyLimit <= 0) return false;

  const periodStart = new Date();
  periodStart.setUTCDate(1);
  periodStart.setUTCHours(0, 0, 0, 0);

  const rows = await sql`
    SELECT COALESCE(SUM(reads + writes + websocket_connects), 0)::bigint AS total
    FROM api_usage_counters
    WHERE project_id = ${projectId}
      AND period_granularity = 'month'
      AND period_start = ${periodStart.toISOString()}
  `;
  const total = Number(rows[0]?.total || 0);
  return total >= monthlyLimit;
}

export async function getMonthlyQuotaError(
  sql: SqlClient,
  projectId: string | null,
  entitlements: Record<string, unknown> | null | undefined,
): Promise<string | null> {
  if (!projectId || !shouldEnforceMonthlyQuota(entitlements)) return null;
  const monthlyLimit = getEntitlementNumber(entitlements, "monthlyRequests", 0);
  if (monthlyLimit <= 0) return null;
  const exceeded = await isProjectMonthlyQuotaExceeded(sql, projectId, entitlements);
  if (!exceeded) return null;
  return `Monthly request quota exceeded (${monthlyLimit})`;
}

export function generateApiKey(): { rawKey: string; keyPrefix: string; keyHash: string } {
  const visible = randomBytes(6).toString("hex");
  const secret = randomBytes(24).toString("hex");
  const rawKey = `${API_KEY_PREFIX}${visible}.${secret}`;
  const keyPrefix = `${API_KEY_PREFIX}${visible}`;
  return { rawKey, keyPrefix, keyHash: hashApiKey(rawKey) };
}

export function buildSessionToken(payload: SessionPayload, secret: string): string {
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", secret).update(encodedPayload).digest("base64url");
  return `${encodedPayload}.${signature}`;
}

export function verifySessionToken(token: string, secret: string): SessionPayload | null {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [encodedPayload, signature] = parts;
  const expected = createHmac("sha256", secret).update(encodedPayload).digest();
  const actual = Buffer.from(signature, "base64url");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  const payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")) as SessionPayload;
  if (!payload.accountId || !payload.walletAddress || !payload.exp) return null;
  if (payload.exp <= Math.floor(Date.now() / 1000)) return null;
  return payload;
}

export async function createAuthNonce(sql: SqlClient, walletAddress: string): Promise<string> {
  const nonce = randomBytes(16).toString("hex");
  await sql`
    INSERT INTO api_auth_nonces (wallet_address, nonce, expires_at)
    VALUES (${walletAddress}, ${nonce}, NOW() + (${NONCE_TTL_SECONDS} || ' seconds')::interval)
    ON CONFLICT (wallet_address)
    DO UPDATE SET nonce = EXCLUDED.nonce, expires_at = EXCLUDED.expires_at, created_at = NOW()
  `;
  return nonce;
}

export async function verifyWalletSignature(sql: SqlClient, walletAddress: string, signature: string): Promise<{ ok: true; accountId: string; tokenPayload: SessionPayload } | { ok: false; error: string }> {
  const rows = await sql`
    SELECT wallet_address, nonce
    FROM api_auth_nonces
    WHERE wallet_address = ${walletAddress}
      AND expires_at > NOW()
    LIMIT 1
  `;
  if (rows.length === 0) return { ok: false, error: "No active nonce for wallet" };
  const nonce = rows[0].nonce as string;
  const message = `OpenOrderBook API login nonce: ${nonce}`;
  let recovered: string;
  try {
    recovered = (await recoverMessageAddress({ message, signature: signature as Hex })).toLowerCase();
  } catch {
    return { ok: false, error: "Invalid signature" };
  }
  if (recovered !== walletAddress) return { ok: false, error: "Signature does not match wallet" };
  const accountRows = await sql`
    INSERT INTO api_accounts (primary_wallet_address)
    VALUES (${walletAddress})
    ON CONFLICT (primary_wallet_address)
    DO UPDATE SET updated_at = NOW()
    RETURNING id
  `;
  const accountId = accountRows[0].id as string;
  await sql`
    INSERT INTO api_account_wallets (account_id, wallet_address, is_primary)
    VALUES (${accountId}, ${walletAddress}, true)
    ON CONFLICT (wallet_address)
    DO NOTHING
  `;
  await sql`DELETE FROM api_auth_nonces WHERE wallet_address = ${walletAddress}`;
  return {
    ok: true,
    accountId,
    tokenPayload: {
      accountId,
      walletAddress,
      exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
    },
  };
}

export async function requireSessionAccount(request: Request, env: Env): Promise<{ ok: true; session: SessionPayload } | { ok: false; error: string }> {
  const authHeader = request.headers.get("Authorization") || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (!token) return { ok: false, error: "Missing bearer session token" };
  if (!env.SESSION_SECRET) return { ok: false, error: "SESSION_SECRET is not configured" };
  const payload = verifySessionToken(token, env.SESSION_SECRET);
  if (!payload) return { ok: false, error: "Invalid or expired session token" };
  return { ok: true, session: payload };
}

export async function listProjectsForAccount(sql: SqlClient, accountId: string): Promise<any[]> {
  return sql`
    SELECT p.id, p.name, p.slug, p.status, p.created_at,
      s.status AS subscription_status,
      s.current_period_start,
      s.current_period_end,
      pl.code AS plan_code,
      pl.name AS plan_name,
      pl.entitlements_json
    FROM api_projects p
    LEFT JOIN LATERAL (
      SELECT * FROM api_project_subscriptions s
      WHERE s.project_id = p.id
      ORDER BY s.current_period_end DESC
      LIMIT 1
    ) s ON true
    LEFT JOIN api_plans pl ON pl.id = s.plan_id
    WHERE p.account_id = ${accountId}
    ORDER BY p.created_at DESC
  `;
}

export async function listPlans(sql: SqlClient): Promise<any[]> {
  return sql`
    SELECT code, name, price_usdc_cents, billing_period_days, entitlements_json
    FROM api_plans
    WHERE active = true
    ORDER BY price_usdc_cents ASC, billing_period_days ASC
  `;
}

export async function createPaymentQuoteForProject(
  sql: SqlClient,
  env: Env,
  accountId: string,
  projectId: string,
  planCode: string,
): Promise<any> {
  const paymentChainId = Number(env.SUBSCRIPTION_PAYMENT_CHAIN_ID || 8453);
  const tokenAddress = normalizeAddress(String(env.SUBSCRIPTION_PAYMENT_TOKEN_ADDRESS || ""));
  const recipientAddress = normalizeAddress(String(env.SUBSCRIPTION_TREASURY_ADDRESS || ""));
  if (!isValidWalletAddress(tokenAddress)) throw new Error("SUBSCRIPTION_PAYMENT_TOKEN_ADDRESS is not configured");
  if (!isValidWalletAddress(recipientAddress)) throw new Error("SUBSCRIPTION_TREASURY_ADDRESS is not configured");

  const rows = await sql`
    SELECT p.id AS project_id, pl.id AS plan_id, pl.code, pl.name, pl.price_usdc_cents, pl.billing_period_days
    FROM api_projects p
    JOIN api_plans pl ON pl.code = ${planCode} AND pl.active = true
    WHERE p.id = ${projectId} AND p.account_id = ${accountId} AND p.status = 'active'
    LIMIT 1
  `;
  if (rows.length === 0) throw new Error("Project or plan not found");
  const plan = rows[0];
  const amountAtomic = BigInt(Number(plan.price_usdc_cents) * 10000).toString();
  const quoteRows = await sql`
    INSERT INTO api_payment_quotes (
      account_id, project_id, plan_id, chain_id, token_address, token_symbol,
      amount_atomic, recipient_address, expires_at, status
    )
    VALUES (
      ${accountId}, ${projectId}, ${plan.plan_id}, ${paymentChainId}, ${tokenAddress}, 'USDC',
      ${amountAtomic}, ${recipientAddress}, NOW() + interval '15 minutes', 'open'
    )
    RETURNING id, project_id, plan_id, chain_id, token_address, token_symbol,
      amount_atomic, recipient_address, expires_at, status, created_at
  `;
  return { ...quoteRows[0], planCode: plan.code, planName: plan.name };
}

async function rpcCall<T>(rpcUrl: string, method: string, params: unknown[]): Promise<T> {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!response.ok) throw new Error(`RPC request failed with status ${response.status}`);
  const payload = await response.json() as { result?: T; error?: { message?: string } };
  if (payload.error) throw new Error(payload.error.message || "RPC error");
  if (payload.result === undefined) throw new Error("RPC response missing result");
  return payload.result;
}

async function verifyQuotePaymentOnChain(env: Env, quote: any, txHash: string, accountWallet: string): Promise<void> {
  const chainId = Number(env.SUBSCRIPTION_PAYMENT_CHAIN_ID || 8453);
  const minConfirmations = Math.max(1, Number(env.SUBSCRIPTION_MIN_CONFIRMATIONS || 1));
  if (Number(quote.chain_id) !== chainId) throw new Error("Quote chain does not match configured payment chain");
  const rpcUrl = chainId === 8453 ? env.RPC_URL_BASE : undefined;
  if (!rpcUrl) throw new Error("Payment verification RPC is not configured for the subscription chain");

  const [txReceipt, tx, latestBlockHex] = await Promise.all([
    rpcCall<any>(rpcUrl, "eth_getTransactionReceipt", [txHash]),
    rpcCall<any>(rpcUrl, "eth_getTransactionByHash", [txHash]),
    rpcCall<string>(rpcUrl, "eth_blockNumber", []),
  ]);
  if (!txReceipt || txReceipt.status !== "0x1") throw new Error("Transaction is not confirmed successfully");
  if (!tx || !tx.blockNumber) throw new Error("Transaction has not been mined yet");

  const latestBlock = BigInt(latestBlockHex);
  const txBlock = BigInt(tx.blockNumber);
  const confirmations = latestBlock >= txBlock ? Number(latestBlock - txBlock + 1n) : 0;
  if (confirmations < minConfirmations) throw new Error(`Transaction needs ${minConfirmations} confirmations`);

  const fromAddress = normalizeAddress(String(tx.from || ""));
  if (fromAddress !== accountWallet) throw new Error("Transaction sender does not match authenticated wallet");

  const expectedToken = normalizeAddress(String(quote.token_address || ""));
  const expectedRecipient = normalizeAddress(String(quote.recipient_address || ""));
  const expectedAmount = BigInt(String(quote.amount_atomic || "0"));

  const matchingTransfer = (txReceipt.logs as RpcLog[]).find((log) => {
    if (normalizeAddress(log.address) !== expectedToken) return false;
    try {
      const topics = (log.topics ?? []) as [Hex, ...Hex[]];
      if (topics.length === 0) return false;
      const decoded = decodeEventLog({ abi: [ERC20_TRANSFER_EVENT], data: log.data as Hex, topics });
      return (
        normalizeAddress(String(decoded.args.from || "")) === fromAddress &&
        normalizeAddress(String(decoded.args.to || "")) === expectedRecipient &&
        BigInt(decoded.args.value as bigint) === expectedAmount
      );
    } catch {
      return false;
    }
  });

  if (!matchingTransfer) {
    throw new Error("No matching USDC transfer to the subscription treasury was found in the transaction");
  }
}

export async function verifyPaymentForProject(
  sql: SqlClient,
  env: Env,
  accountId: string,
  projectId: string,
  walletAddress: string,
  quoteId: string,
  txHash: string,
): Promise<PaymentVerificationResult> {
  const normalizedTxHash = txHash.toLowerCase();
  if (!isTxHashFormat(normalizedTxHash)) throw new Error("Invalid txHash format");

  const priorPaymentByTx = await getPaymentVerificationResultByTxHash(sql, normalizedTxHash);
  if (priorPaymentByTx) {
    return priorPaymentByTx;
  }

  const priorPaymentByQuote = await getPaymentVerificationResultByQuoteId(sql, quoteId);
  if (priorPaymentByQuote) {
    return priorPaymentByQuote;
  }

  const quoteRows = await sql`
    SELECT q.*, pl.billing_period_days, pl.id AS resolved_plan_id
    FROM api_payment_quotes q
    JOIN api_plans pl ON pl.id = q.plan_id
    WHERE q.id = ${quoteId}
      AND q.project_id = ${projectId}
      AND q.account_id = ${accountId}
      AND q.status = 'open'
      AND q.expires_at > NOW()
    LIMIT 1
  `;
  if (quoteRows.length === 0) throw new Error("Open payment quote not found");
  const quote = quoteRows[0];

  await verifyQuotePaymentOnChain(env, quote, normalizedTxHash, walletAddress);

  let subscriptionRows: any[] = [];
  try {
    subscriptionRows = await sql`
      WITH payment_row AS (
        INSERT INTO api_payments (
          account_id, project_id, quote_id, chain_id, token_address, amount_atomic,
          tx_hash, from_address, to_address, confirmed_at, status
        )
        VALUES (
          ${accountId}, ${projectId}, ${quote.id}, ${quote.chain_id}, ${quote.token_address}, ${quote.amount_atomic},
          ${normalizedTxHash}, ${walletAddress}, ${quote.recipient_address}, NOW(), 'confirmed'
        )
        RETURNING id
      ), current_subscription AS (
        SELECT *
        FROM api_project_subscriptions
        WHERE project_id = ${projectId}
          AND status = 'active'
          AND current_period_end > NOW()
        ORDER BY current_period_end DESC
        LIMIT 1
      ), updated_subscription AS (
        UPDATE api_project_subscriptions
        SET
          plan_id = ${quote.resolved_plan_id},
          current_period_start = CASE
            WHEN current_period_end > NOW() THEN current_period_start
            ELSE NOW()
          END,
          current_period_end = GREATEST(current_period_end, NOW()) + (${quote.billing_period_days} || ' days')::interval,
          cancel_at_period_end = false,
          status = 'active',
          updated_at = NOW()
        WHERE id = (SELECT id FROM current_subscription)
        RETURNING id, project_id, status, current_period_end
      ), inserted_subscription AS (
        INSERT INTO api_project_subscriptions (
          project_id, plan_id, status, current_period_start, current_period_end, cancel_at_period_end
        )
        SELECT
          ${projectId}, ${quote.resolved_plan_id}, 'active',
          NOW(),
          NOW() + (${quote.billing_period_days} || ' days')::interval,
          false
        WHERE NOT EXISTS (SELECT 1 FROM updated_subscription)
        RETURNING id, project_id, status, current_period_end
      ), payment_update AS (
        UPDATE api_payments
        SET subscription_id = COALESCE((SELECT id FROM updated_subscription), (SELECT id FROM inserted_subscription))
        WHERE id = (SELECT id FROM payment_row)
        RETURNING id
      ), quote_update AS (
        UPDATE api_payment_quotes
        SET status = 'paid'
        WHERE id = ${quote.id}
        RETURNING id
      )
      SELECT
        (SELECT id FROM payment_row) AS payment_id,
        id,
        project_id,
        status,
        current_period_end
      FROM updated_subscription
      UNION ALL
      SELECT
        (SELECT id FROM payment_row) AS payment_id,
        id,
        project_id,
        status,
        current_period_end
      FROM inserted_subscription
    `;
  } catch (error) {
    if (!isUniqueViolation(error)) {
      throw error;
    }
    const existingResult =
      (await getPaymentVerificationResultByTxHash(sql, normalizedTxHash)) ||
      (await getPaymentVerificationResultByQuoteId(sql, quote.id as string));
    if (existingResult) {
      return existingResult;
    }
    throw new Error("Payment verification raced with another request; please retry");
  }

  if (subscriptionRows.length === 0) throw new Error("Failed to activate subscription");

  return {
    paymentId: subscriptionRows[0].payment_id as string,
    subscriptionId: subscriptionRows[0].id as string,
    projectId: subscriptionRows[0].project_id as string,
    status: subscriptionRows[0].status as string,
    currentPeriodEnd: subscriptionRows[0].current_period_end as string,
  };
}

export async function createProjectForAccount(sql: SqlClient, accountId: string, name: string): Promise<any> {
  const baseSlug = slugifyProjectName(name);
  const slugSuffix = String(Math.floor(Date.now() / 1000));
  const rows = await sql`
    WITH next_slug AS (
      SELECT CASE
        WHEN EXISTS (SELECT 1 FROM api_projects WHERE slug = ${baseSlug})
          THEN ${baseSlug} || '-' || ${slugSuffix}
        ELSE ${baseSlug}
      END AS slug_value
    ), new_project AS (
      INSERT INTO api_projects (account_id, name, slug)
      SELECT ${accountId}, ${name}, slug_value FROM next_slug
      RETURNING id, account_id, name, slug, status, created_at
    )
    SELECT * FROM new_project
  `;
  return rows[0];
}

export async function listApiKeys(sql: SqlClient, accountId: string, projectId: string): Promise<any[]> {
  return sql`
    SELECT k.id, k.name, k.key_prefix, k.status, k.last_used_at, k.created_at, k.revoked_at
    FROM api_keys k
    JOIN api_projects p ON p.id = k.project_id
    WHERE k.project_id = ${projectId}
      AND p.account_id = ${accountId}
    ORDER BY k.created_at DESC
  `;
}

export async function createApiKeyForProject(sql: SqlClient, accountId: string, projectId: string, name: string): Promise<{ id: string; name: string; keyPrefix: string; rawKey: string; createdAt: string }> {
  const projectRows = await sql`
    SELECT p.id, pl.code AS plan_code, COALESCE(pl.entitlements_json, '{}'::jsonb) AS entitlements_json
    FROM api_projects p
    JOIN LATERAL (
      SELECT s.plan_id
      FROM api_project_subscriptions s
      WHERE s.project_id = p.id AND s.status = 'active' AND s.current_period_end > NOW()
      ORDER BY s.current_period_end DESC
      LIMIT 1
    ) s ON true
    JOIN api_plans pl ON pl.id = s.plan_id
    WHERE p.id = ${projectId} AND p.account_id = ${accountId}
    LIMIT 1
  `;
  if (projectRows.length === 0) throw new Error("Active paid subscription required before creating API keys");
  const maxApiKeys = Number(projectRows[0].entitlements_json?.maxApiKeys ?? 1);
  if (maxApiKeys <= 0) {
    throw new Error("Current plan does not permit API keys");
  }
  const activeKeyRows = await sql`
    SELECT COUNT(*)::int AS count
    FROM api_keys
    WHERE project_id = ${projectId} AND status = 'active'
  `;
  if (Number(activeKeyRows[0].count || 0) >= maxApiKeys) {
    throw new Error(`Project has reached its API key limit (${maxApiKeys})`);
  }
  const generated = generateApiKey();
  const rows = await sql`
    INSERT INTO api_keys (project_id, name, key_prefix, key_hash)
    VALUES (${projectId}, ${name}, ${generated.keyPrefix}, ${generated.keyHash})
    RETURNING id, created_at
  `;
  return {
    id: rows[0].id as string,
    name,
    keyPrefix: generated.keyPrefix,
    rawKey: generated.rawKey,
    createdAt: rows[0].created_at as string,
  };
}

export async function resolveApiKeyAccess(sql: SqlClient, rawApiKey: string): Promise<ResolvedApiAccess | null> {
  const keyHash = hashApiKey(rawApiKey);
  const rows = await sql`
    SELECT
      a.id AS account_id,
      p.id AS project_id,
      k.id AS api_key_id,
      pl.code AS plan_code,
      pl.entitlements_json AS entitlements_json
    FROM api_keys k
    JOIN api_projects p ON p.id = k.project_id
    JOIN api_accounts a ON a.id = p.account_id
    JOIN LATERAL (
      SELECT * FROM api_project_subscriptions s
      WHERE s.project_id = p.id AND s.status = 'active' AND s.current_period_end > NOW()
      ORDER BY s.current_period_end DESC
      LIMIT 1
    ) s ON true
    JOIN api_plans pl ON pl.id = s.plan_id
    WHERE k.key_hash = ${keyHash}
      AND k.status = 'active'
      AND p.status = 'active'
      AND a.status = 'active'
      AND pl.code IN (${STARTER_PLAN_CODE}, ${PRO_PLAN_CODE})
    LIMIT 1
  `;
  if (rows.length === 0) return null;
  await sql`
    UPDATE api_keys
    SET last_used_at = NOW()
    WHERE id = ${rows[0].api_key_id as string}
  `;
  return {
    accountId: rows[0].account_id as string,
    projectId: rows[0].project_id as string,
    apiKeyId: rows[0].api_key_id as string,
    planCode: rows[0].plan_code as string,
    entitlements: rows[0].entitlements_json as Record<string, unknown>,
  };
}

export async function incrementUsageCounter(sql: SqlClient, projectId: string, apiKeyId: string | null, kind: 'read' | 'write' | 'websocket'): Promise<void> {
  const periodStart = new Date();
  periodStart.setUTCDate(1);
  periodStart.setUTCHours(0, 0, 0, 0);
  const apiKeyScope = apiKeyId ?? ZERO_UUID;
  await sql`
    INSERT INTO api_usage_counters (
      project_id, api_key_id, api_key_scope, period_start, period_granularity, reads, writes, websocket_connects
    )
    VALUES (
      ${projectId}, ${apiKeyId}, ${apiKeyScope}, ${periodStart.toISOString()}, 'month',
      ${kind === 'read' ? 1 : 0},
      ${kind === 'write' ? 1 : 0},
      ${kind === 'websocket' ? 1 : 0}
    )
    ON CONFLICT (project_id, api_key_scope, period_start, period_granularity)
    DO UPDATE SET
      reads = api_usage_counters.reads + ${kind === 'read' ? 1 : 0},
      writes = api_usage_counters.writes + ${kind === 'write' ? 1 : 0},
      websocket_connects = api_usage_counters.websocket_connects + ${kind === 'websocket' ? 1 : 0},
      updated_at = NOW()
  `;
}
