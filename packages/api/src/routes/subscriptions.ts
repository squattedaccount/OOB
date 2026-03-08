import { getPooledSqlClient } from "../db.js";
import { jsonError, jsonResponse } from "../response.js";
import type { RouteContext } from "../types.js";
import {
  buildSessionToken,
  createPaymentQuoteForProject,
  createApiKeyForProject,
  createAuthNonce,
  createProjectForAccount,
  isValidWalletAddress,
  listPlans,
  listApiKeys,
  listProjectsForAccount,
  normalizeAddress,
  requireSessionAccount,
  verifyPaymentForProject,
  verifyWalletSignature,
} from "../subscriptions.js";

async function readJson(request: Request): Promise<any> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

export async function handleListPlans(ctx: RouteContext): Promise<Response> {
  const sql = getPooledSqlClient(ctx.env);
  const plans = await listPlans(sql);
  return jsonResponse({ plans });
}

export async function handleCreatePaymentQuote(ctx: RouteContext): Promise<Response> {
  const session = await requireSessionAccount(ctx.request, ctx.env);
  if (!session.ok) return jsonError(401, session.error);
  const projectId = ctx.segments[2] || "";
  if (!projectId) return jsonError(400, "Missing project id");
  const body = await readJson(ctx.request);
  const planCode = String(body?.planCode || "").trim().toLowerCase();
  if (!planCode) return jsonError(400, "Missing planCode");
  const sql = getPooledSqlClient(ctx.env);
  try {
    const quote = await createPaymentQuoteForProject(sql, ctx.env, session.session.accountId, projectId, planCode);
    return jsonResponse({ quote }, 201);
  } catch (err: any) {
    return jsonError(400, err.message || "Failed to create payment quote");
  }
}

export async function handleVerifyPayment(ctx: RouteContext): Promise<Response> {
  const session = await requireSessionAccount(ctx.request, ctx.env);
  if (!session.ok) return jsonError(401, session.error);
  const projectId = ctx.segments[2] || "";
  if (!projectId) return jsonError(400, "Missing project id");
  const body = await readJson(ctx.request);
  const quoteId = String(body?.quoteId || "").trim();
  const txHash = String(body?.txHash || "").trim().toLowerCase();
  if (!quoteId) return jsonError(400, "Missing quoteId");
  if (!txHash) return jsonError(400, "Missing txHash");
  const sql = getPooledSqlClient(ctx.env);
  try {
    const result = await verifyPaymentForProject(
      sql,
      ctx.env,
      session.session.accountId,
      projectId,
      normalizeAddress(session.session.walletAddress),
      quoteId,
      txHash,
    );
    return jsonResponse({ payment: result }, 201);
  } catch (err: any) {
    return jsonError(400, err.message || "Failed to verify payment");
  }
}

export async function handleCreateAuthNonce(ctx: RouteContext): Promise<Response> {
  const body = await readJson(ctx.request);
  const walletAddress = normalizeAddress(String(body?.walletAddress || ""));
  if (!isValidWalletAddress(walletAddress)) {
    return jsonError(400, "Invalid walletAddress");
  }
  const sql = getPooledSqlClient(ctx.env);
  const nonce = await createAuthNonce(sql, walletAddress);
  return jsonResponse({ walletAddress, nonce, message: `OpenOrderBook API login nonce: ${nonce}` }, 201);
}

export async function handleVerifyAuth(ctx: RouteContext): Promise<Response> {
  if (!ctx.env.SESSION_SECRET) {
    return jsonError(503, "SESSION_SECRET is not configured");
  }
  const body = await readJson(ctx.request);
  const walletAddress = normalizeAddress(String(body?.walletAddress || ""));
  const signature = String(body?.signature || "");
  if (!isValidWalletAddress(walletAddress)) {
    return jsonError(400, "Invalid walletAddress");
  }
  if (!signature) {
    return jsonError(400, "Missing signature");
  }
  const sql = getPooledSqlClient(ctx.env);
  const result = await verifyWalletSignature(sql, walletAddress, signature);
  if (!result.ok) {
    return jsonError(400, result.error);
  }
  const token = buildSessionToken(result.tokenPayload, ctx.env.SESSION_SECRET);
  return jsonResponse({ token, accountId: result.accountId, walletAddress }, 201);
}

export async function handleListProjects(ctx: RouteContext): Promise<Response> {
  const session = await requireSessionAccount(ctx.request, ctx.env);
  if (!session.ok) return jsonError(401, session.error);
  const sql = getPooledSqlClient(ctx.env);
  const projects = await listProjectsForAccount(sql, session.session.accountId);
  return jsonResponse({ projects });
}

export async function handleCreateProject(ctx: RouteContext): Promise<Response> {
  const session = await requireSessionAccount(ctx.request, ctx.env);
  if (!session.ok) return jsonError(401, session.error);
  const body = await readJson(ctx.request);
  const name = String(body?.name || "").trim();
  if (name.length < 3 || name.length > 64) {
    return jsonError(400, "Project name must be between 3 and 64 characters");
  }
  const sql = getPooledSqlClient(ctx.env);
  const project = await createProjectForAccount(sql, session.session.accountId, name);
  return jsonResponse({ project }, 201);
}

export async function handleListApiKeys(ctx: RouteContext): Promise<Response> {
  const session = await requireSessionAccount(ctx.request, ctx.env);
  if (!session.ok) return jsonError(401, session.error);
  const projectId = ctx.segments[2] || "";
  if (!projectId) return jsonError(400, "Missing project id");
  const sql = getPooledSqlClient(ctx.env);
  const apiKeys = await listApiKeys(sql, session.session.accountId, projectId);
  return jsonResponse({ apiKeys });
}

export async function handleCreateApiKey(ctx: RouteContext): Promise<Response> {
  const session = await requireSessionAccount(ctx.request, ctx.env);
  if (!session.ok) return jsonError(401, session.error);
  const projectId = ctx.segments[2] || "";
  if (!projectId) return jsonError(400, "Missing project id");
  const body = await readJson(ctx.request);
  const name = String(body?.name || "").trim();
  if (name.length < 2 || name.length > 64) {
    return jsonError(400, "API key name must be between 2 and 64 characters");
  }
  const sql = getPooledSqlClient(ctx.env);
  try {
    const apiKey = await createApiKeyForProject(sql, session.session.accountId, projectId, name);
    return jsonResponse({ apiKey }, 201);
  } catch (err: any) {
    return jsonError(400, err.message || "Failed to create API key");
  }
}
