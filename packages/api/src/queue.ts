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
import { RedisCache, CacheKeys } from "./cache.js";
import { broadcastOrderEvent } from "./routes/orders.js";

const MAX_ACTIVE_ORDERS_PER_OFFERER = 500;

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

  const cache = new RedisCache(env);

  if (toInsert.length === 0) {
    console.log("[oob-queue] All orders in batch are duplicates — skipping");
    return;
  }

  const offerers = Array.from(new Set(toInsert.map((m) => m.body.offerer)));
  const listingCandidates = toInsert.filter((m) => m.body.orderType === "listing");

  let activeCounts = new Map<string, number>();
  let activeListingKeys = new Set<string>();

  try {
    if (offerers.length > 0) {
      const counts = await sql`
        SELECT offerer, COUNT(*)::int AS active_count
        FROM seaport_orders
        WHERE offerer = ANY(${offerers})
          AND status = 'active'
        GROUP BY offerer
      `;
      activeCounts = new Map(counts.map((r: any) => [r.offerer, Number(r.active_count)]));
    }

    if (listingCandidates.length > 0) {
      const existingListings = await sql`
        SELECT offerer, chain_id, nft_contract, token_id
        FROM seaport_orders
        WHERE status = 'active'
          AND order_type = 'listing'
          AND offerer = ANY(${Array.from(new Set(listingCandidates.map((m) => m.body.offerer)))})
      `;
      activeListingKeys = new Set(
        existingListings.map((r: any) => `${r.offerer}:${r.chain_id}:${r.nft_contract}:${r.token_id}`),
      );
    }
  } catch (err) {
    console.error("[oob-queue] Failed to load queue-side invariants:", err);
    batch.retryAll();
    return;
  }

  const accepted: typeof toInsert = [];
  const rejected: typeof toInsert = [];
  const batchListingKeys = new Set<string>();

  for (const message of toInsert) {
    const offerer = message.body.offerer;
    const currentActive = activeCounts.get(offerer) ?? 0;
    if (currentActive >= MAX_ACTIVE_ORDERS_PER_OFFERER) {
      rejected.push(message);
      continue;
    }

    if (message.body.orderType === "listing") {
      const listingKey = `${message.body.offerer}:${message.body.chainId}:${message.body.nftContract}:${message.body.tokenId}`;
      if (activeListingKeys.has(listingKey) || batchListingKeys.has(listingKey)) {
        rejected.push(message);
        continue;
      }
      batchListingKeys.add(listingKey);
    }

    accepted.push(message);
    activeCounts.set(offerer, currentActive + 1);
  }

  if (rejected.length > 0) {
    await Promise.allSettled(rejected.map((m) => cache.clearDedup(m.body.orderHash)));
    console.warn(`[oob-queue] Dropped ${rejected.length} queued orders that failed authoritative invariants`);
  }

  if (accepted.length === 0) {
    return;
  }

  // Bulk INSERT using unnest for efficiency
  try {
    const now = Math.floor(Date.now() / 1000);

    await sql`
      INSERT INTO seaport_orders (
        order_hash, chain_id, offerer, zone,
        nft_contract, token_id, asset_scope, identifier_or_criteria, token_standard,
        order_type, price_wei, currency,
        protocol_fee_recipient, protocol_fee_bps,
        origin_fees_json, origin_fee_bps,
        royalty_recipient, royalty_bps,
        order_json, signature,
        start_time, end_time,
        status
      )
      SELECT * FROM unnest(
        ${accepted.map((m) => m.body.orderHash)}::text[],
        ${accepted.map((m) => m.body.chainId)}::int[],
        ${accepted.map((m) => m.body.offerer)}::text[],
        ${accepted.map((m) => m.body.zone)}::text[],
        ${accepted.map((m) => m.body.nftContract)}::text[],
        ${accepted.map((m) => m.body.tokenId)}::text[],
        ${accepted.map((m) => m.body.assetScope)}::text[],
        ${accepted.map((m) => m.body.identifierOrCriteria)}::text[],
        ${accepted.map((m) => m.body.tokenStandard)}::text[],
        ${accepted.map((m) => m.body.orderType)}::text[],
        ${accepted.map((m) => m.body.priceWei)}::text[],
        ${accepted.map((m) => m.body.currency)}::text[],
        ${accepted.map((m) => m.body.protocolFeeRecipient)}::text[],
        ${accepted.map((m) => m.body.protocolFeeBps)}::int[],
        ${accepted.map((m) => JSON.stringify(m.body.originFees))}::text[],
        ${accepted.map((m) => m.body.originFeeBps)}::int[],
        ${accepted.map((m) => m.body.royaltyRecipient)}::text[],
        ${accepted.map((m) => m.body.royaltyBps)}::int[],
        ${accepted.map((m) => JSON.stringify(m.body.order))}::text[],
        ${accepted.map((m) => m.body.signature)}::text[],
        ${accepted.map((m) => m.body.startTime)}::int[],
        ${accepted.map((m) => m.body.endTime)}::int[],
        ${"active"}::text[]
      ) AS t(
        order_hash, chain_id, offerer, zone,
        nft_contract, token_id, asset_scope, identifier_or_criteria, token_standard,
        order_type, price_wei, currency,
        protocol_fee_recipient, protocol_fee_bps,
        origin_fees_json, origin_fee_bps,
        royalty_recipient, royalty_bps,
        order_json, signature,
        start_time, end_time,
        status
      )
      ON CONFLICT (order_hash) DO NOTHING
    `;

    console.log(`[oob-queue] Inserted ${accepted.length} orders`);
  } catch (err) {
    console.error("[oob-queue] Bulk INSERT failed:", err);
    batch.retryAll();
    return;
  }

  // Log activity for each inserted order (best-effort, non-blocking)
  const activityPromises = accepted.map((m) =>
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
  const cachePromises = accepted.map(async (m) => {
    try {
      const chainIdStr = String(m.body.chainId);
      const nftContract = m.body.nftContract;
      await Promise.all([
        cache.del(CacheKeys.allBestListings(chainIdStr, nftContract)),
        cache.del(CacheKeys.allCollectionStats(chainIdStr, nftContract)),
        cache.del(CacheKeys.allOrdersLists(chainIdStr, nftContract)),
      ]);
    } catch {
      // Non-fatal
    }
  });

  const broadcastPromises = accepted.map((m) =>
    broadcastOrderEvent(env, m.body.orderType === "listing" ? "new_listing" : "new_offer", {
      orderHash: m.body.orderHash,
      chainId: m.body.chainId,
      nftContract: m.body.nftContract,
      tokenId: m.body.tokenId,
      offerer: m.body.offerer,
      priceWei: m.body.priceWei,
      currency: m.body.currency,
      orderType: m.body.orderType,
    }).catch((err) => console.error("[oob-queue] broadcast failed:", err)),
  );

  await Promise.allSettled([...activityPromises, ...cachePromises, ...broadcastPromises]);
}
