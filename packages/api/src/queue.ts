/**
 * Cloudflare Queue consumer for write-behind order ingestion.
 *
 * When ORDER_INGEST_QUEUE is configured, the API validates orders and enqueues
 * them for async DB insertion instead of writing synchronously. This decouples
 * the API response latency from Neon DB write latency and prevents connection
 * saturation under high batch submission loads.
 *
 * The queue consumer receives batches of up to 50 messages (configured in
 * wrangler.toml) and performs a single bulk INSERT per batch.
 *
 * Retry behaviour: CF Queues retries failed messages up to max_retries times
 * (configured in wrangler.toml). Messages that exhaust retries go to the DLQ.
 */

import type { Env, OrderIngestMessage } from "./types.js";
import { getPooledSqlClient } from "./db.js";
import { logActivity } from "./activity.js";
import { RedisCache } from "./cache.js";

export async function handleOrderIngestQueue(
  batch: MessageBatch<OrderIngestMessage>,
  env: Env,
): Promise<void> {
  const sql = getPooledSqlClient(env);
  const messages = batch.messages;

  if (messages.length === 0) return;

  console.log(`[oob-queue] Processing batch of ${messages.length} orders`);

  // Deduplicate within the batch itself (same order submitted twice in burst)
  const seen = new Set<string>();
  const unique = messages.filter((m) => {
    if (seen.has(m.body.orderHash)) return false;
    seen.add(m.body.orderHash);
    return true;
  });

  // Fetch existing order hashes in one DB query to skip true duplicates
  const hashes = unique.map((m) => m.body.orderHash);
  let existingHashes = new Set<string>();
  try {
    const existing = await sql`
      SELECT order_hash FROM seaport_orders
      WHERE order_hash = ANY(${hashes})
    `;
    existingHashes = new Set(existing.map((r: any) => r.order_hash));
  } catch (err) {
    console.error("[oob-queue] Failed to check existing hashes:", err);
    // Retry the whole batch — ack nothing
    batch.retryAll();
    return;
  }

  const toInsert = unique.filter((m) => !existingHashes.has(m.body.orderHash));

  if (toInsert.length === 0) {
    console.log("[oob-queue] All orders in batch are duplicates — skipping");
    return;
  }

  // Bulk INSERT using unnest for efficiency
  try {
    const now = Math.floor(Date.now() / 1000);

    await sql`
      INSERT INTO seaport_orders (
        order_hash, chain_id, offerer, zone,
        nft_contract, token_id, token_standard,
        order_type, price_wei, currency,
        fee_recipient, fee_bps,
        royalty_recipient, royalty_bps,
        order_json, signature,
        start_time, end_time,
        status
      )
      SELECT * FROM unnest(
        ${toInsert.map((m) => m.body.orderHash)}::text[],
        ${toInsert.map((m) => m.body.chainId)}::int[],
        ${toInsert.map((m) => m.body.offerer)}::text[],
        ${toInsert.map((m) => m.body.zone)}::text[],
        ${toInsert.map((m) => m.body.nftContract)}::text[],
        ${toInsert.map((m) => m.body.tokenId)}::text[],
        ${toInsert.map((m) => m.body.tokenStandard)}::text[],
        ${toInsert.map((m) => m.body.orderType)}::text[],
        ${toInsert.map((m) => m.body.priceWei)}::text[],
        ${toInsert.map((m) => m.body.currency)}::text[],
        ${toInsert.map((m) => m.body.feeRecipient)}::text[],
        ${toInsert.map((m) => m.body.feeBps)}::int[],
        ${toInsert.map((m) => m.body.royaltyRecipient)}::text[],
        ${toInsert.map((m) => m.body.royaltyBps)}::int[],
        ${toInsert.map((m) => JSON.stringify(m.body.order))}::text[],
        ${toInsert.map((m) => m.body.signature)}::text[],
        ${toInsert.map((m) => m.body.startTime)}::int[],
        ${toInsert.map((m) => m.body.endTime)}::int[],
        ${"active"}::text[]
      ) AS t(
        order_hash, chain_id, offerer, zone,
        nft_contract, token_id, token_standard,
        order_type, price_wei, currency,
        fee_recipient, fee_bps,
        royalty_recipient, royalty_bps,
        order_json, signature,
        start_time, end_time,
        status
      )
      ON CONFLICT (order_hash) DO NOTHING
    `;

    console.log(`[oob-queue] Inserted ${toInsert.length} orders`);
  } catch (err) {
    console.error("[oob-queue] Bulk INSERT failed:", err);
    batch.retryAll();
    return;
  }

  // Log activity for each inserted order (best-effort, non-blocking)
  const activityPromises = toInsert.map((m) =>
    logActivity(sql, {
      orderHash: m.body.orderHash,
      chainId: m.body.chainId,
      eventType: m.body.orderType === "listing" ? "listed" : "offer_placed",
      fromAddress: m.body.offerer,
      nftContract: m.body.nftContract,
      tokenId: m.body.tokenId,
      priceWei: m.body.priceWei,
      currency: m.body.currency,
    }).catch((err) => console.error("[oob-queue] logActivity failed:", err)),
  );

  // Invalidate Redis cache for affected collections (best-effort)
  const cachePromises = toInsert.map(async (m) => {
    try {
      const cache = new RedisCache(env);
      const chainIdStr = String(m.body.chainId);
      const nftContract = m.body.nftContract;
      await Promise.all([
        cache.del(`oob:best-listing:${chainIdStr}:${nftContract}`),
        cache.del(`oob:stats:${chainIdStr}:${nftContract}`),
      ]);
    } catch {
      // Non-fatal
    }
  });

  await Promise.allSettled([...activityPromises, ...cachePromises]);
}
