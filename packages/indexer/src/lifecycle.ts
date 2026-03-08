/**
 * OOB Indexer — Order Lifecycle Manager
 *
 * Processes decoded Seaport lifecycle events and updates the seaport_orders
 * table in the OOB Neon database.
 *
 * Event types:
 *   - fulfilled → status = 'filled', record filled_tx_hash + filled_at
 *   - cancelled → status = 'cancelled', record cancelled_tx_hash + cancelled_at
 *   - counter_incremented → bulk-cancel all active orders for the offerer on that chain
 */

import type { SqlClient } from "./db.js";
import type { SeaportLifecycleEvent } from "./types.js";

export interface LifecycleResult {
  updated: number;
  affectedCollections: { chainId: number; address: string }[];
}

async function logActivity(
  sql: SqlClient,
  params: {
    orderHash: string;
    chainId: number;
    eventType: string;
    fromAddress?: string | null;
    toAddress?: string | null;
    nftContract?: string | null;
    tokenId?: string | null;
    priceWei?: string | null;
    txHash?: string | null;
  },
): Promise<void> {
  try {
    await sql`
      INSERT INTO order_activity (
        order_hash, chain_id, event_type,
        from_address, to_address,
        nft_contract, token_id,
        price_wei, tx_hash
      ) VALUES (
        ${params.orderHash}, ${params.chainId}, ${params.eventType},
        ${params.fromAddress || null}, ${params.toAddress || null},
        ${params.nftContract || null}, ${params.tokenId || null},
        ${params.priceWei || null}, ${params.txHash || null}
      )
    `;
  } catch (err) {
    console.error("[oob-indexer] Failed to log activity:", err);
  }
}

/**
 * Process a batch of Seaport lifecycle events and update the database.
 */
export async function processLifecycleEvents(
  sql: SqlClient,
  events: SeaportLifecycleEvent[],
): Promise<LifecycleResult> {
  if (events.length === 0) return { updated: 0, affectedCollections: [] };

  let updated = 0;
  const affectedCollections: { chainId: number; address: string }[] = [];

  for (const evt of events) {
    try {
      if (evt.type === "fulfilled" && evt.orderHash) {
        const result = await sql`
          UPDATE seaport_orders
          SET status = 'filled', filled_tx_hash = ${evt.txHash}, filled_at = NOW()
          WHERE order_hash = ${evt.orderHash} AND status = 'active'
          RETURNING chain_id, nft_contract, token_id, price_wei, offerer
        `;
        const rows = Array.isArray(result) ? result : [];
        if (rows.length > 0) {
          updated++;
          for (const r of rows) {
            affectedCollections.push({ chainId: r.chain_id, address: r.nft_contract });
            await logActivity(sql, {
              orderHash: evt.orderHash,
              chainId: r.chain_id,
              eventType: "filled",
              fromAddress: r.offerer,
              toAddress: null, // buyer address decoded from OrderFulfilled event in future
              nftContract: r.nft_contract,
              tokenId: r.token_id,
              priceWei: r.price_wei,
              txHash: evt.txHash,
            });
          }
        }
      } else if (evt.type === "cancelled" && evt.orderHash) {
        const result = await sql`
          UPDATE seaport_orders
          SET status = 'cancelled', cancelled_tx_hash = ${evt.txHash}, cancelled_at = NOW()
          WHERE order_hash = ${evt.orderHash} AND status = 'active'
          RETURNING chain_id, nft_contract, token_id, price_wei, offerer
        `;
        const rows = Array.isArray(result) ? result : [];
        if (rows.length > 0) {
          updated++;
          for (const r of rows) {
            affectedCollections.push({ chainId: r.chain_id, address: r.nft_contract });
            await logActivity(sql, {
              orderHash: evt.orderHash,
              chainId: r.chain_id,
              eventType: "cancelled",
              fromAddress: r.offerer,
              nftContract: r.nft_contract,
              tokenId: r.token_id,
              priceWei: r.price_wei,
              txHash: evt.txHash,
            });
          }
        }
      } else if (evt.type === "counter_incremented" && evt.offerer) {
        const result = await sql`
          UPDATE seaport_orders
          SET status = 'cancelled', cancelled_tx_hash = ${evt.txHash}, cancelled_at = NOW()
          WHERE offerer = ${evt.offerer}
            AND chain_id = ${evt.chainId}
            AND status = 'active'
          RETURNING order_hash, chain_id, nft_contract, token_id, price_wei
        `;
        const rows = Array.isArray(result) ? result : [];
        updated += rows.length;
        for (const r of rows) {
          affectedCollections.push({ chainId: r.chain_id, address: r.nft_contract });
          await logActivity(sql, {
            orderHash: r.order_hash,
            chainId: r.chain_id,
            eventType: "cancelled",
            fromAddress: evt.offerer,
            nftContract: r.nft_contract,
            tokenId: r.token_id,
            priceWei: r.price_wei,
            txHash: evt.txHash,
          });
        }
      }
    } catch (err) {
      console.error(`[oob-indexer] Failed to process ${evt.type} event:`, err);
    }
  }

  if (updated > 0) {
    console.log(
      `[oob-indexer] Updated ${updated} orders from ${events.length} lifecycle events`,
    );
  }

  return { updated, affectedCollections };
}
