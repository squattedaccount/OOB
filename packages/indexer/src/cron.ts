/**
 * OOB Indexer — Cron Jobs
 *
 * Runs every 5 minutes via Cloudflare Worker cron trigger:
 *
 * 1. Expire orders past their end_time
 * 2. Detect stale listings (NFT transferred away from offerer)
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
 * Uses eth_call with ownerOf(uint256) selector = 0x6352211e
 */
async function detectStaleOrders(
  sql: SqlClient,
  env: Env,
): Promise<number> {
  const limit = parseInt(env.STALE_CHECK_LIMIT || "50", 10);

  try {
    const activeListings = await sql`
      SELECT order_hash, chain_id, nft_contract, token_id, offerer
      FROM seaport_orders
      WHERE status = 'active'
        AND order_type = 'listing'
        AND token_standard = 'ERC721'
      ORDER BY created_at ASC
      LIMIT ${limit}
    `;

    const listings = Array.isArray(activeListings) ? activeListings : [];
    if (listings.length === 0) return 0;

    const staleHashes: string[] = [];

    for (const listing of listings) {
      const rpcUrl = getRpcUrl(env, listing.chain_id);
      if (!rpcUrl) continue;

      try {
        const tokenIdHex = BigInt(listing.token_id).toString(16).padStart(64, "0");
        const callData = "0x6352211e" + tokenIdHex;

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
            staleHashes.push(listing.order_hash);
          }
        }
      } catch {
        // Skip individual RPC failures — don't mark as stale on error
      }
    }

    if (staleHashes.length > 0) {
      const staleRows = await sql`
        UPDATE seaport_orders
        SET status = 'stale'
        WHERE order_hash = ANY(${staleHashes})
          AND status = 'active'
        RETURNING order_hash, chain_id, offerer, nft_contract, token_id, price_wei
      `;
      const rows = Array.isArray(staleRows) ? staleRows : [];
      console.log(
        `[oob-indexer] Marked ${rows.length} orders as stale (NFT transferred)`,
      );
      for (const r of rows) {
        try {
          await sql`
            INSERT INTO order_activity (order_hash, chain_id, event_type, from_address, nft_contract, token_id, price_wei)
            VALUES (${r.order_hash}, ${r.chain_id}, 'stale', ${r.offerer}, ${r.nft_contract}, ${r.token_id}, ${r.price_wei})
          `;
        } catch { /* activity logging should not break cron */ }
      }
    }

    return staleHashes.length;
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
