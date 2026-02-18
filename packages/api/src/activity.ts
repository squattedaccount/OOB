/**
 * Activity logging — records every order lifecycle event.
 *
 * Events: listed, offer_placed, filled, cancelled, expired, stale
 */

import type { SqlClient } from "./db.js";

export interface ActivityEvent {
  orderHash: string;
  chainId: number;
  eventType: "listed" | "offer_placed" | "filled" | "cancelled" | "expired" | "stale";
  fromAddress?: string | null;
  toAddress?: string | null;
  nftContract?: string | null;
  tokenId?: string | null;
  priceWei?: string | null;
  currency?: string | null;
  txHash?: string | null;
}

export async function logActivity(sql: SqlClient, event: ActivityEvent): Promise<void> {
  try {
    await sql`
      INSERT INTO order_activity (
        order_hash, chain_id, event_type,
        from_address, to_address,
        nft_contract, token_id,
        price_wei, currency, tx_hash
      ) VALUES (
        ${event.orderHash},
        ${event.chainId},
        ${event.eventType},
        ${event.fromAddress || null},
        ${event.toAddress || null},
        ${event.nftContract || null},
        ${event.tokenId || null},
        ${event.priceWei || null},
        ${event.currency || null},
        ${event.txHash || null}
      )
    `;
  } catch (err) {
    // Activity logging should never break the main flow
    console.error("[oob-api] Failed to log activity:", err);
  }
}

export async function logActivityBatch(sql: SqlClient, events: ActivityEvent[]): Promise<void> {
  if (events.length === 0) return;
  if (events.length === 1) return logActivity(sql, events[0]);

  try {
    const values = events
      .map((_, i) => {
        const base = i * 10;
        return `($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},$${base + 7},$${base + 8},$${base + 9},$${base + 10})`;
      })
      .join(",");

    const params = events.flatMap((e) => [
      e.orderHash, e.chainId, e.eventType,
      e.fromAddress || null, e.toAddress || null,
      e.nftContract || null, e.tokenId || null,
      e.priceWei || null, e.currency || null,
      e.txHash || null,
    ]);

    await sql(
      `INSERT INTO order_activity (order_hash, chain_id, event_type, from_address, to_address, nft_contract, token_id, price_wei, currency, tx_hash) VALUES ${values}`,
      params,
    );
  } catch (err) {
    // Activity logging should never break the main flow
    console.error("[oob-api] Failed to batch log activity:", err);
  }
}
