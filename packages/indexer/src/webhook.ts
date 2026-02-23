/**
 * OOB Indexer — Webhook Handler
 *
 * Receives on-chain log events from webhook providers (Alchemy, Moralis, Goldsky)
 * and processes Seaport lifecycle events.
 *
 * Supports multiple payload formats:
 *   - Alchemy Notify: { webhookId, id, createdAt, type, event: { data: { block, logs } } }
 *   - Moralis Streams: { confirmed, chainId, logs: [...], block: { number, timestamp } }
 *   - Goldsky Mirror: { data: [{ chain_id, topics, data, ... }] } or raw array
 *   - Generic: { chainId, logs: [{ address, topics, data, transactionHash, blockNumber }] }
 */

import type { Env, SeaportLifecycleEvent, WebhookLogEntry, ProcessingResult } from "./types.js";
import type { SqlClient } from "./db.js";
import { decodeSeaportEvent, isSeaportLog } from "./seaport.js";
import { processLifecycleEvents } from "./lifecycle.js";
import { extractTransferEvents, processTransferEvents } from "./transfer.js";

// ─── Payload Normalization ──────────────────────────────────────────────────

interface NormalizedPayload {
  chainId: number;
  logs: WebhookLogEntry[];
}

/**
 * Normalize webhook payloads from various providers into a common format.
 */
function normalizePayload(body: any, headers: Headers): NormalizedPayload {
  // Alchemy Notify format
  if (body?.event?.data?.block && Array.isArray(body.event.data.block.logs)) {
    const block = body.event.data.block;
    const chainId = body.event?.network
      ? alchemyNetworkToChainId(body.event.network)
      : 1;
    const logs: WebhookLogEntry[] = block.logs.map((log: any) => ({
      address: log.account?.address || log.address || "",
      topics: log.topics || [],
      data: log.data || "0x",
      transactionHash: log.transaction?.hash || log.transactionHash || "",
      blockNumber: block.number,
      blockTimestamp: block.timestamp
        ? new Date(Number(block.timestamp) * 1000).toISOString()
        : undefined,
    }));
    return { chainId, logs };
  }

  // Moralis Streams format
  if (body?.logs && body?.block && body?.chainId) {
    const chainId = moralisChainToId(body.chainId);
    const logs: WebhookLogEntry[] = body.logs.map((log: any) => ({
      address: log.address || "",
      topics: [log.topic0, log.topic1, log.topic2, log.topic3].filter(Boolean),
      data: log.data || "0x",
      transactionHash: log.transactionHash || "",
      blockNumber: body.block.number,
      blockTimestamp: body.block.timestamp
        ? new Date(Number(body.block.timestamp) * 1000).toISOString()
        : undefined,
    }));
    return { chainId, logs };
  }

  // Goldsky Mirror format: { data: [...] } or raw array
  const entries = Array.isArray(body) ? body : body?.data;
  if (Array.isArray(entries) && entries.length > 0 && entries[0].topics !== undefined) {
    const headerChainId = Number(headers.get("x-goldsky-chain") || "0");
    const logs: WebhookLogEntry[] = entries.map((entry: any) => {
      const topicsStr = entry.topics || "";
      const topics: string[] = Array.isArray(topicsStr)
        ? topicsStr
        : typeof topicsStr === "string" && topicsStr.startsWith("[")
          ? JSON.parse(topicsStr)
          : typeof topicsStr === "string"
            ? topicsStr.split(",").map((t: string) => t.trim())
            : [];
      return {
        address: entry.address || "",
        topics,
        data: entry.data || "0x",
        transactionHash: entry.transaction_hash || "",
        blockNumber: entry.block_number || 0,
        blockTimestamp: entry.block_timestamp,
        chainId: entry.chain_id || headerChainId,
      };
    });
    const chainId = entries[0].chain_id || headerChainId || 1;
    return { chainId, logs };
  }

  // Generic format: { chainId, logs: [...] }
  if (body?.chainId && Array.isArray(body?.logs)) {
    return {
      chainId: Number(body.chainId),
      logs: body.logs.map((log: any) => ({
        address: log.address || "",
        topics: log.topics || [],
        data: log.data || "0x",
        transactionHash: log.transactionHash || "",
        blockNumber: log.blockNumber || 0,
        blockTimestamp: log.blockTimestamp,
      })),
    };
  }

  return { chainId: 0, logs: [] };
}

function alchemyNetworkToChainId(network: string): number {
  const map: Record<string, number> = {
    ETH_MAINNET: 1,
    BASE_MAINNET: 8453,
    BASE_SEPOLIA: 84532,
    ARB_MAINNET: 42161,
    OPT_MAINNET: 10,
    RONIN_MAINNET: 2020,
    RONIN_TESTNET: 202601,
    RONIN_SAIGON: 202601,
  };
  return map[network] || 1;
}

function moralisChainToId(chainId: string): number {
  const map: Record<string, number> = {
    "0x1": 1,
    "0x2105": 8453,
    "0x3e7": 999,
    "0x7e4": 2020,
    "0x31769": 202601,
    "0xab5": 2741,
  };
  return map[chainId.toLowerCase()] || parseInt(chainId, 16) || 0;
}

// ─── Webhook Verification ───────────────────────────────────────────────────

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

async function verifyAlchemyHmac(
  body: string,
  signature: string,
  signingKey: string,
): Promise<boolean> {
  try {
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(signingKey),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const mac = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
    const computed = Array.from(new Uint8Array(mac))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    return constantTimeEqual(computed, signature);
  } catch {
    return false;
  }
}

async function verifyWebhook(
  request: Request,
  env: Env,
  rawBody?: string,
): Promise<boolean> {
  if (!env.WEBHOOK_SECRET) {
    console.error("[oob-indexer] CRITICAL: WEBHOOK_SECRET not configured — ALL webhooks rejected! Set with: wrangler secret put WEBHOOK_SECRET");
    return false;
  }

  // Method 1: Alchemy HMAC-SHA256 signature (x-alchemy-signature header)
  const alchemySig = request.headers.get("x-alchemy-signature");
  if (alchemySig && rawBody) {
    // Try dedicated Alchemy signing key first, then fall back to WEBHOOK_SECRET
    if (env.ALCHEMY_SIGNING_KEY) {
      const valid = await verifyAlchemyHmac(rawBody, alchemySig, env.ALCHEMY_SIGNING_KEY);
      if (valid) return true;
    }
    return verifyAlchemyHmac(rawBody, alchemySig, env.WEBHOOK_SECRET);
  }

  // Method 2: Simple token header (Goldsky, Moralis, or custom)
  const secret =
    request.headers.get("x-webhook-secret") ||
    request.headers.get("x-goldsky-secret") ||
    request.headers.get("x-alchemy-token") ||
    request.headers.get("authorization")?.replace("Bearer ", "");

  if (!secret) return false;
  return constantTimeEqual(secret, env.WEBHOOK_SECRET);
}

// ─── Main Handler ───────────────────────────────────────────────────────────

const MAX_WEBHOOK_BODY = 1024 * 1024; // 1 MB hard limit
const DEDUP_TTL_HOURS = 24; // Keep dedup keys for 24h

/**
 * Compute a stable fingerprint for webhook payloads that lack a delivery ID.
 * Uses chainId + sorted txHash:logIndex pairs from the logs.
 */
function computeEventFingerprint(body: any, headers: Headers): string {
  const parts: string[] = [];

  // Try to extract tx hashes from various payload formats
  const logs: any[] =
    body?.event?.data?.block?.logs ||
    body?.logs ||
    (Array.isArray(body) ? body : body?.data) ||
    [];

  for (const log of logs) {
    const txHash = log?.transaction?.hash || log?.transactionHash || log?.transaction_hash || "";
    const logIndex = log?.logIndex ?? log?.log_index ?? "";
    if (txHash) parts.push(`${txHash}:${logIndex}`);
  }

  if (parts.length === 0) return "";

  const chainId = body?.event?.network ||
    body?.chainId ||
    headers.get("x-goldsky-chain") || "0";
  parts.sort();
  return `fp:${chainId}:${parts.join(",")}`;
}

/**
 * Check dedup key in shared DB. Returns true if this is a duplicate.
 * Inserts the key if new (with ON CONFLICT DO NOTHING for race safety).
 */
async function checkAndSetDedup(sql: SqlClient, dedupKey: string): Promise<boolean> {
  try {
    const result = await sql`
      INSERT INTO webhook_dedup (dedup_key)
      VALUES (${dedupKey})
      ON CONFLICT (dedup_key) DO NOTHING
      RETURNING dedup_key
    `;
    // If RETURNING is empty, the key already existed → duplicate
    return result.length === 0;
  } catch {
    // If table doesn't exist yet or DB error, allow through (fail open for webhooks)
    return false;
  }
}

/**
 * Clean up old dedup entries (called opportunistically).
 */
async function cleanupDedup(sql: SqlClient): Promise<void> {
  try {
    await sql`
      DELETE FROM webhook_dedup
      WHERE created_at < NOW() - INTERVAL '24 hours'
    `;
  } catch {
    // Non-critical cleanup failure
  }
}

export async function handleWebhook(
  request: Request,
  env: Env,
  sql: SqlClient,
): Promise<Response> {
  // Read raw body with hard size limit (prevents memory/CPU DoS)
  let rawBody: string;
  try {
    const reader = request.body?.getReader();
    if (!reader) {
      return new Response(JSON.stringify({ error: "No body" }), {
        status: 400, headers: { "Content-Type": "application/json" },
      });
    }
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_WEBHOOK_BODY) {
        reader.cancel();
        return new Response(JSON.stringify({ error: "Payload too large" }), {
          status: 413, headers: { "Content-Type": "application/json" },
        });
      }
      chunks.push(value);
    }
    const merged = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.byteLength; }
    rawBody = new TextDecoder().decode(merged);
  } catch {
    return new Response(JSON.stringify({ error: "Failed to read body" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Verify webhook secret
  const isValid = await verifyWebhook(request, env, rawBody);
  if (!isValid) {
    console.warn("[oob-indexer] Invalid webhook secret");
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Parse body
  let body: any;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Cross-instance replay protection via shared DB.
  // Only use provider-supplied delivery IDs from headers (never from body — body is
  // attacker-influenced and could be used to suppress legitimate events by pre-sending
  // a fake payload with the same ID). Fall back to a content fingerprint, and if that
  // is also empty (unusual payload structure), skip dedup rather than block processing.
  const deliveryId = request.headers.get("x-alchemy-webhook-id")
    || request.headers.get("x-webhook-id")
    || request.headers.get("x-goldsky-webhook-id")
    || "";
  const dedupKey = deliveryId
    ? `wh:${deliveryId}`
    : computeEventFingerprint(body, request.headers);

  if (dedupKey) {
    const isDuplicate = await checkAndSetDedup(sql, dedupKey);
    if (isDuplicate) {
      return new Response(
        JSON.stringify({ success: true, message: "Duplicate delivery, skipped" }),
        { headers: { "Content-Type": "application/json" } },
      );
    }
  }

  // Opportunistic cleanup (~1% of requests)
  if (Math.random() < 0.01) {
    cleanupDedup(sql).catch(() => { });
  }

  // Moralis sends unconfirmed events first — skip them
  if (body?.confirmed === false) {
    return new Response(
      JSON.stringify({ success: true, message: "Skipping unconfirmed" }),
      { headers: { "Content-Type": "application/json" } },
    );
  }

  // Normalize payload
  const { chainId, logs } = normalizePayload(body, request.headers);

  if (logs.length === 0) {
    return new Response(
      JSON.stringify({ success: true, received: 0, processed: 0 }),
      { headers: { "Content-Type": "application/json" } },
    );
  }

  // Decode Seaport lifecycle events
  const events: SeaportLifecycleEvent[] = [];
  for (const log of logs) {
    const logChainId = (log as any).chainId || chainId;
    const evt = decodeSeaportEvent(log, logChainId);
    if (evt) events.push(evt);
  }

  // Decode ERC-721 Transfer events for stale listing detection
  const transferEvents = extractTransferEvents(logs, chainId);

  // Process Seaport lifecycle events
  const result: ProcessingResult = {
    received: logs.length,
    processed: events.length,
    fulfilled: 0,
    cancelled: 0,
    counterIncremented: 0,
    errors: 0,
  };

  if (events.length > 0) {
    const { updated } = await processLifecycleEvents(sql, events);
    result.fulfilled = events.filter((e) => e.type === "fulfilled").length;
    result.cancelled = events.filter((e) => e.type === "cancelled").length;
    result.counterIncremented = events.filter(
      (e) => e.type === "counter_incremented",
    ).length;

    console.log(
      `[oob-indexer] Webhook: received=${result.received} seaport=${result.processed} ` +
      `fulfilled=${result.fulfilled} cancelled=${result.cancelled} ` +
      `counterIncr=${result.counterIncremented} dbUpdated=${updated}`,
    );
  }

  // Process Transfer events (stale detection).
  // Awaited directly — Cloudflare Workers kill unawaited promises after response.
  // The DB query is a fast indexed point lookup so latency impact is negligible.
  if (transferEvents.length > 0) {
    try {
      await processTransferEvents(sql, transferEvents);
    } catch (err) {
      console.error("[oob-indexer] Transfer stale processing error:", err);
    }
  }

  return new Response(JSON.stringify({ success: true, ...result }), {
    headers: { "Content-Type": "application/json" },
  });
}
