/**
 * OOB Indexer — ERC-721 Transfer Event Handler
 *
 * Decodes ERC-721 Transfer logs from any webhook provider and marks active
 * listings as stale when the offerer transfers the listed token away.
 *
 * How it works:
 *   1. Decode Transfer(from, to, tokenId) from raw log entries
 *   2. Skip mints (from = 0x000...000) — no listing can exist before mint
 *   3. Batch-query all active listings matching (chainId, nftContract, tokenId, offerer=from)
 *   4. Mark matched listings as 'stale' and log activity
 *
 * The offerer=from check is critical: we only care when the *lister* transfers
 * the token away. If a buyer re-sells after filling, that's a separate listing
 * and is handled normally.
 */

import type { SqlClient } from "./db.js";
import type { WebhookLogEntry, TransferEvent } from "./types.js";

// ERC-721 Transfer(address indexed from, address indexed to, uint256 indexed tokenId)
// All three parameters are indexed → they appear in topics[1], topics[2], topics[3]
const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

// ─── Decoding ───────────────────────────────────────────────────────────────

/**
 * Decode a single log entry as an ERC-721 Transfer event.
 * Returns null if the log is not a valid ERC-721 Transfer.
 *
 * ERC-721 Transfer has exactly 4 topics (topic0 + 3 indexed params).
 * ERC-20 Transfer has only 3 topics (topic0 + 2 indexed params, value in data).
 * We use the 4-topic check to distinguish ERC-721 from ERC-20.
 */
function decodeTransferLog(
  log: WebhookLogEntry,
  defaultChainId: number,
): TransferEvent | null {
  const topics = log.topics;

  // Must have exactly 4 topics: event sig + from + to + tokenId (all indexed)
  if (!topics || topics.length !== 4) return null;
  if (topics[0]?.toLowerCase() !== TRANSFER_TOPIC) return null;

  try {
    // Each indexed address topic is a 32-byte word; address is the last 20 bytes
    const from = "0x" + topics[1].slice(-40).toLowerCase();
    const to = "0x" + topics[2].slice(-40).toLowerCase();

    // tokenId is a uint256 encoded as a 32-byte hex word in the topic.
    // Normalize to decimal string — Seaport SDK serializes identifierOrCriteria
    // as a decimal string in order JSON, so the DB always stores decimal.
    const tokenIdHex = topics[3].startsWith("0x") ? topics[3].slice(2) : topics[3];
    if (tokenIdHex.length === 0) return null;
    const tokenId = BigInt("0x" + tokenIdHex).toString(10);

    const nftContract = log.address.toLowerCase();
    const chainId = (log as any).chainId || defaultChainId;
    const txHash = log.transactionHash || "";

    return { chainId, nftContract, tokenId, from, to, txHash, blockNumber: log.blockNumber };
  } catch {
    // Malformed topic data — skip silently
    return null;
  }
}

/**
 * Extract all valid ERC-721 Transfer events from a batch of log entries.
 * Skips mints (from = zero address).
 */
export function extractTransferEvents(
  logs: WebhookLogEntry[],
  defaultChainId: number,
): TransferEvent[] {
  const events: TransferEvent[] = [];
  for (const log of logs) {
    const evt = decodeTransferLog(log, defaultChainId);
    if (!evt) continue;
    // Skip mints — the token didn't exist before, so no listing can be stale
    if (evt.from === ZERO_ADDRESS) continue;
    events.push(evt);
  }
  return events;
}

// ─── Stale Detection ────────────────────────────────────────────────────────

export interface TransferProcessingResult {
  transfersReceived: number;
  staleMarked: number;
}

/**
 * Process a batch of Transfer events and mark affected listings as stale.
 *
 * Batching strategy: group by (chainId, nftContract) and issue one query per
 * group. This avoids N individual queries while keeping the SQL simple and
 * index-friendly. In practice most webhook batches cover 1–3 collections.
 */
export async function processTransferEvents(
  sql: SqlClient,
  events: TransferEvent[],
): Promise<TransferProcessingResult> {
  if (events.length === 0) return { transfersReceived: 0, staleMarked: 0 };

  let staleMarked = 0;

  // Group by chainId so we can query each chain's listings together
  const byChain = new Map<number, TransferEvent[]>();
  for (const evt of events) {
    const group = byChain.get(evt.chainId) ?? [];
    group.push(evt);
    byChain.set(evt.chainId, group);
  }

  for (const [chainId, chainEvents] of byChain) {
    try {
      staleMarked += await markStaleForChain(sql, chainId, chainEvents);
    } catch (err) {
      console.error(
        `[oob-indexer] Transfer stale check failed for chain ${chainId}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  if (staleMarked > 0) {
    console.log(
      `[oob-indexer] Transfer events: received=${events.length} stale_marked=${staleMarked}`,
    );
  }

  return { transfersReceived: events.length, staleMarked };
}

/**
 * For a single chain, find all active listings where:
 *   - nft_contract + token_id matches a transfer event
 *   - offerer = the 'from' address of that transfer
 *
 * We build a VALUES list of (nft_contract, token_id, offerer) tuples and join
 * against seaport_orders. This is a single query regardless of batch size.
 */
async function markStaleForChain(
  sql: SqlClient,
  chainId: number,
  events: TransferEvent[],
): Promise<number> {
  if (events.length === 0) return 0;

  // Deduplicate: if the same (contract, tokenId, from) appears multiple times
  // in one batch (e.g. token moved twice in same block), only process once.
  const seen = new Set<string>();
  const unique = events.filter((e) => {
    const key = `${e.nftContract}:${e.tokenId}:${e.from}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Build a parameterized query using unnest for the tuple filter.
  // This is the most efficient pattern for Neon/Postgres batch lookups.
  //
  // SELECT order_hash, nft_contract, token_id, offerer, price_wei
  // FROM seaport_orders
  // WHERE chain_id = $1
  //   AND status = 'active'
  //   AND order_type = 'listing'
  //   AND token_standard = 'ERC721'
  //   AND (nft_contract, token_id, offerer) IN (
  //     SELECT * FROM unnest($2::text[], $3::text[], $4::text[])
  //   )

  const contracts = unique.map((e) => e.nftContract);
  const tokenIds = unique.map((e) => e.tokenId);
  const offerers = unique.map((e) => e.from);

  // Find matching active listings
  const matchRows = await sql`
    SELECT order_hash, chain_id, nft_contract, token_id, offerer, price_wei
    FROM seaport_orders
    WHERE chain_id = ${chainId}
      AND status = 'active'
      AND order_type = 'listing'
      AND token_standard = 'ERC721'
      AND (nft_contract, token_id, offerer) IN (
        SELECT * FROM unnest(
          ${contracts}::text[],
          ${tokenIds}::text[],
          ${offerers}::text[]
        )
      )
  `;

  const matches = Array.isArray(matchRows) ? matchRows : [];
  if (matches.length === 0) return 0;

  // Mark them stale in one UPDATE
  const staleHashes = matches.map((r: any) => r.order_hash as string);

  const updatedRows = await sql`
    UPDATE seaport_orders
    SET status = 'stale', stale_checked_at = NOW()
    WHERE order_hash = ANY(${staleHashes})
      AND status = 'active'
    RETURNING order_hash, chain_id, offerer, nft_contract, token_id, price_wei
  `;
  const updated = Array.isArray(updatedRows) ? updatedRows : [];

  // Build a txHash lookup for activity logging (best-effort)
  const txByKey = new Map<string, string>();
  for (const e of unique) {
    txByKey.set(`${e.nftContract}:${e.tokenId}:${e.from}`, e.txHash);
  }

  // Log activity for each stale order
  for (const r of updated) {
    try {
      const txHash =
        txByKey.get(`${r.nft_contract}:${r.token_id}:${r.offerer}`) ?? null;
      await sql`
        INSERT INTO order_activity (
          order_hash, chain_id, event_type,
          from_address, nft_contract, token_id, price_wei, tx_hash
        ) VALUES (
          ${r.order_hash}, ${r.chain_id}, 'stale',
          ${r.offerer}, ${r.nft_contract}, ${r.token_id}, ${r.price_wei},
          ${txHash}
        )
      `;
    } catch {
      // Activity logging must never break the main flow
    }
  }

  return updated.length;
}
