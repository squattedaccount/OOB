/**
 * OOB Indexer — Cron Jobs
 *
 * Runs every 5 minutes via Cloudflare Worker cron trigger:
 *
 * 1. Expire orders past their end_time
 * 2. Detect stale listings (NFT transferred away from offerer)
 *    Uses Multicall3 to batch all ownerOf checks per chain into a single RPC call.
 */

import type { SqlClient } from "./db.js";
import type { Env, CronResult } from "./types.js";

// ─── RPC URL Resolution ────────────────────────────────────────────────────

const CHAIN_RPC_MAP: Record<number, keyof Env> = {
  1: "RPC_URL_ETHEREUM",
  8453: "RPC_URL_BASE",
  84532: "RPC_URL_BASE_SEPOLIA",
  999: "RPC_URL_HYPERLIQUID",
  2020: "RPC_URL_RONIN",
  202601: "RPC_URL_RONIN_TESTNET",
  2741: "RPC_URL_ABSTRACT",
};

function getRpcUrl(env: Env, chainId: number): string | undefined {
  const key = CHAIN_RPC_MAP[chainId];
  return key ? (env[key] as string | undefined) : undefined;
}

// ─── Multicall3 ────────────────────────────────────────────────────────────

/**
 * Multicall3 is deployed at the same address on most EVM chains.
 * Chains without it (Hyperliquid, Ronin) fall back to individual eth_calls.
 * Reference: https://github.com/mds1/multicall
 */
const MULTICALL3_ADDRESS = "0xcA11bde05977b3631167028862bE2a173976CA11";

// Chains where Multicall3 is confirmed deployed
const MULTICALL3_CHAINS = new Set([1, 8453, 84532, 2741]);

// ownerOf(uint256) selector
const OWNER_OF_SELECTOR = "0x6352211e";

/**
 * ABI-encode a uint256 as a 32-byte hex string (no 0x prefix).
 */
function encodeUint256(value: string): string {
  return BigInt(value).toString(16).padStart(64, "0");
}

/**
 * ABI-decode a Multicall3 tryAggregate response.
 *
 * tryAggregate returns: (bool success, bytes returnData)[]
 * ABI encoding: dynamic array → offset(32) + length(32) + N × (offset_i(32)) + N × (success(32) + dataOffset(32) + dataLen(32) + data)
 *
 * Simpler approach: parse the raw hex manually.
 * Each result tuple is: success (32 bytes) + data_offset (32 bytes) + data_length (32 bytes) + data (padded)
 * But tryAggregate returns a dynamic array of structs, so we use a known layout.
 *
 * We use a simpler fixed-layout decode: each call returns exactly 32 bytes (address),
 * so returnData is always 32 bytes. Layout per element in the packed results:
 *   [0..31]   success (bool, right-padded)
 *   [32..63]  offset to returnData bytes (always 0x40 = 64 for a 32-byte result)
 *   [64..95]  returnData length (32)
 *   [96..127] returnData (the address, left-padded to 32 bytes)
 * Total: 128 bytes per call result in the dynamic portion.
 */
function decodeMulticallResults(hex: string, count: number): (string | null)[] {
  // Strip 0x and the outer array header (offset + length = 64 bytes = 128 hex chars)
  const data = hex.startsWith("0x") ? hex.slice(2) : hex;
  // Skip: array offset (64 hex) + array length (64 hex) = 128 hex chars
  const body = data.slice(128);

  const results: (string | null)[] = [];

  for (let i = 0; i < count; i++) {
    try {
      // Each element is a dynamic struct (Result): encoded as an offset pointer first
      // The offset section: count × 32 bytes (64 hex chars each)
      const offsetHex = body.slice(i * 64, i * 64 + 64);
      const offset = parseInt(offsetHex, 16) * 2; // byte offset → hex char offset

      // At offset: success (32 bytes) + data_offset (32 bytes) + data_len (32 bytes) + data (32 bytes)
      const successHex = body.slice(offset, offset + 64);
      const success = successHex.slice(-1) === "1";
      if (!success) {
        results.push(null);
        continue;
      }

      // data is at offset + 64 (skip success) + 64 (skip inner offset) + 64 (skip length) = offset + 192
      const addrHex = body.slice(offset + 192, offset + 256);
      if (addrHex.length < 64) {
        results.push(null);
        continue;
      }
      // Address is the last 40 hex chars of the 32-byte word
      const owner = "0x" + addrHex.slice(-40).toLowerCase();
      results.push(owner);
    } catch {
      results.push(null);
    }
  }

  return results;
}

interface ListingRow {
  order_hash: string;
  chain_id: number;
  nft_contract: string;
  token_id: string;
  offerer: string;
}

/**
 * Build the calldata for Multicall3.tryAggregate(bool requireSuccess, Call[] calls).
 *
 * tryAggregate selector: 0x252dba42
 * requireSuccess = false (don't revert on individual failures)
 *
 * Call struct: (address target, bytes callData)
 * Each call: ownerOf(tokenId) on the NFT contract
 */
function buildMulticallCalldata(listings: ListingRow[]): string {
  const selector = "252dba42"; // tryAggregate(bool,Call[])
  const requireSuccess = "0".padStart(64, "0"); // false

  // Array offset: points to where the array starts (after requireSuccess = 32 bytes → 0x40)
  const arrayOffset = "40".padStart(64, "0");

  // Array length
  const arrayLen = listings.length.toString(16).padStart(64, "0");

  // Each Call struct is dynamic (contains bytes), so we encode:
  // 1. Array of offsets to each Call struct (relative to start of array body)
  // 2. Each Call struct: address (32 bytes) + offset-to-bytes (32) + bytes-length (32) + bytes-data (32)
  // Each Call struct body = 4 × 32 bytes = 128 bytes = 256 hex chars
  // Offset to Call[i] = i * 128 bytes (since all calls have same fixed size)

  const callStructSize = 128; // bytes per encoded Call struct
  const offsets = listings
    .map((_, i) => (i * callStructSize).toString(16).padStart(64, "0"))
    .join("");

  const callBodies = listings.map((l) => {
    const target = l.nft_contract.slice(2).toLowerCase().padStart(64, "0");
    const bytesOffset = "40".padStart(64, "0"); // callData starts at offset 64 within this struct
    const bytesLen = "24".padStart(64, "0");    // 36 bytes = 4 selector + 32 tokenId
    const callData = OWNER_OF_SELECTOR.slice(2) + encodeUint256(l.token_id);
    // callData is 36 bytes, padded to 64 bytes (next 32-byte boundary)
    const callDataPadded = callData.padEnd(64, "0");
    return target + bytesOffset + bytesLen + callDataPadded;
  }).join("");

  return "0x" + selector + requireSuccess + arrayOffset + arrayLen + offsets + callBodies;
}

/**
 * Check ownership for a batch of listings on a single chain using Multicall3.
 * Returns a set of order_hashes that are stale (offerer no longer owns the NFT).
 */
async function checkOwnershipMulticall(
  rpcUrl: string,
  listings: ListingRow[],
): Promise<Set<string>> {
  const stale = new Set<string>();
  if (listings.length === 0) return stale;

  try {
    const calldata = buildMulticallCalldata(listings);

    const resp = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_call",
        params: [{ to: MULTICALL3_ADDRESS, data: calldata }, "latest"],
      }),
    });

    const json = (await resp.json()) as any;
    if (!json.result || json.result === "0x") {
      console.warn("[oob-indexer] Multicall3 returned empty result, falling back to individual calls");
      return checkOwnershipIndividual(rpcUrl, listings);
    }

    const owners = decodeMulticallResults(json.result, listings.length);

    for (let i = 0; i < listings.length; i++) {
      const owner = owners[i];
      if (owner === null) continue; // RPC error for this token — skip, don't mark stale
      if (owner !== listings[i].offerer.toLowerCase()) {
        stale.add(listings[i].order_hash);
      }
    }
  } catch (err) {
    console.warn("[oob-indexer] Multicall3 failed, falling back to individual calls:", err);
    return checkOwnershipIndividual(rpcUrl, listings);
  }

  return stale;
}

/**
 * Fallback: check ownership one-by-one for chains without Multicall3.
 */
async function checkOwnershipIndividual(
  rpcUrl: string,
  listings: ListingRow[],
): Promise<Set<string>> {
  const stale = new Set<string>();

  for (const listing of listings) {
    try {
      const callData = OWNER_OF_SELECTOR + encodeUint256(listing.token_id);
      const resp = await fetch(rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "eth_call",
          params: [{ to: listing.nft_contract, data: callData }, "latest"],
        }),
      });
      const json = (await resp.json()) as any;
      if (json.result && json.result.length >= 42) {
        const owner = "0x" + json.result.slice(-40).toLowerCase();
        if (owner !== listing.offerer.toLowerCase()) {
          stale.add(listing.order_hash);
        }
      }
    } catch {
      // Skip individual RPC failures — don't mark as stale on error
    }
  }

  return stale;
}

// ─── Phase 1: Expire Orders ────────────────────────────────────────────────

async function expireOrders(sql: SqlClient): Promise<number> {
  try {
    const result = await sql`
      UPDATE seaport_orders
      SET status = 'expired'
      WHERE status = 'active'
        AND end_time < EXTRACT(EPOCH FROM NOW())
      RETURNING order_hash, chain_id, offerer, nft_contract, token_id, price_wei
    `;
    const rows = Array.isArray(result) ? result : [];
    if (rows.length > 0) {
      console.log(`[oob-indexer] Expired ${rows.length} orders past end_time`);
      for (const r of rows) {
        try {
          await sql`
            INSERT INTO order_activity (order_hash, chain_id, event_type, from_address, nft_contract, token_id, price_wei)
            VALUES (${r.order_hash}, ${r.chain_id}, 'expired', ${r.offerer}, ${r.nft_contract}, ${r.token_id}, ${r.price_wei})
          `;
        } catch { /* activity logging should not break cron */ }
      }
    }
    return rows.length;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes("does not exist")) {
      console.error("[oob-indexer] Failed to expire orders:", msg);
    }
    return 0;
  }
}

// ─── Phase 2: Stale Order Detection ────────────────────────────────────────

/**
 * Check NFT ownership for active ERC721 listings.
 * If the offerer no longer owns the NFT, mark the order as 'stale'.
 *
 * Groups listings by chain, then issues ONE Multicall3 eth_call per chain
 * instead of one eth_call per listing. At 500 listings across 3 chains,
 * this is 3 RPC calls instead of 500.
 */
async function detectStaleOrders(
  sql: SqlClient,
  env: Env,
): Promise<number> {
  const limit = parseInt(env.STALE_CHECK_LIMIT || "200", 10);

  try {
    // Round-robin: pick listings checked least recently (NULLS FIRST = never checked goes first).
    const activeListings = await sql`
      SELECT order_hash, chain_id, nft_contract, token_id, offerer
      FROM seaport_orders
      WHERE status = 'active'
        AND order_type = 'listing'
        AND token_standard = 'ERC721'
      ORDER BY stale_checked_at ASC NULLS FIRST
      LIMIT ${limit}
    `;

    const listings = (Array.isArray(activeListings) ? activeListings : []) as ListingRow[];
    if (listings.length === 0) return 0;

    // Group by chain_id for batching
    const byChain = new Map<number, ListingRow[]>();
    for (const l of listings) {
      const group = byChain.get(l.chain_id) ?? [];
      group.push(l);
      byChain.set(l.chain_id, group);
    }

    // Check ownership per chain — one Multicall3 call per chain
    const staleHashes = new Set<string>();
    await Promise.all(
      Array.from(byChain.entries()).map(async ([chainId, chainListings]) => {
        const rpcUrl = getRpcUrl(env, chainId);
        if (!rpcUrl) return;

        const chainStale = MULTICALL3_CHAINS.has(chainId)
          ? await checkOwnershipMulticall(rpcUrl, chainListings)
          : await checkOwnershipIndividual(rpcUrl, chainListings);

        for (const hash of chainStale) staleHashes.add(hash);
      }),
    );

    // Stamp all checked listings (advances the round-robin cursor)
    const checkedHashes = listings.map((l) => l.order_hash);
    try {
      await sql`
        UPDATE seaport_orders
        SET stale_checked_at = NOW()
        WHERE order_hash = ANY(${checkedHashes})
      `;
    } catch {
      // Non-fatal: column may not exist yet if migration hasn't run
    }

    if (staleHashes.size > 0) {
      const staleArr = Array.from(staleHashes);
      const staleRows = await sql`
        UPDATE seaport_orders
        SET status = 'stale'
        WHERE order_hash = ANY(${staleArr})
          AND status = 'active'
        RETURNING order_hash, chain_id, offerer, nft_contract, token_id, price_wei
      `;
      const rows = Array.isArray(staleRows) ? staleRows : [];
      console.log(`[oob-indexer] Marked ${rows.length} orders as stale (NFT transferred)`);
      for (const r of rows) {
        try {
          await sql`
            INSERT INTO order_activity (order_hash, chain_id, event_type, from_address, nft_contract, token_id, price_wei)
            VALUES (${r.order_hash}, ${r.chain_id}, 'stale', ${r.offerer}, ${r.nft_contract}, ${r.token_id}, ${r.price_wei})
          `;
        } catch { /* activity logging should not break cron */ }
      }
    }

    console.log(
      `[oob-indexer] Stale check: checked=${listings.length} chains=${byChain.size} stale=${staleHashes.size}`,
    );
    return staleHashes.size;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes("does not exist")) {
      console.error("[oob-indexer] Stale detection failed:", msg);
    }
    return 0;
  }
}

// ─── Main Cron Handler ─────────────────────────────────────────────────────

export async function handleCron(sql: SqlClient, env: Env): Promise<CronResult> {
  const errors: string[] = [];
  let expired = 0;
  let staleDetected = 0;

  // Phase 1: Expire orders
  try {
    expired = await expireOrders(sql);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(`expire: ${msg}`);
  }

  // Phase 2: Stale detection
  try {
    staleDetected = await detectStaleOrders(sql, env);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(`stale: ${msg}`);
  }

  if (expired > 0 || staleDetected > 0 || errors.length > 0) {
    console.log(
      `[oob-indexer] Cron complete: expired=${expired} stale=${staleDetected} errors=${errors.length}`,
    );
  }

  return { expired, staleDetected, errors };
}
