/**
 * OOB Indexer — Seaport Event Decoder
 *
 * Decodes Seaport v1.6 on-chain lifecycle events:
 *   - OrderFulfilled  → mark order as 'filled'
 *   - OrderCancelled  → mark order as 'cancelled'
 *   - CounterIncremented → bulk-cancel all orders for an offerer
 *
 * Seaport 1.6 canonical address: 0x0000000000000068F116a894984e2DB1123eB395
 */

import type { SeaportLifecycleEvent, WebhookLogEntry } from "./types.js";

// ─── Event Signature Hashes ────────────────────────────────────────────────

export const SEAPORT_ADDRESS = "0x0000000000000068f116a894984e2db1123eb395";

export const SEAPORT_EVENTS = {
  // keccak256("OrderFulfilled(bytes32,address,address,address,(uint8,address,uint256,uint256)[],(uint8,address,uint256,uint256,address)[])")
  ORDER_FULFILLED:
    "0x9d9af8e38d66c62e2c12f0225249fd9d721c54b83f48d9352c97c6cacdcb6f31",
  // keccak256("OrderCancelled(bytes32,address,address)")
  ORDER_CANCELLED:
    "0x6bacc01dbe442496068f7d234edd811f1a5f833243e0aec824f86ab861f3c90d",
  // keccak256("CounterIncremented(uint256,address)")
  COUNTER_INCREMENTED:
    "0x721c20121297512b72821b97f5326571674d3f0a0628f63e0a3aabf21bd67864",
} as const;

// ─── Hex Helpers ────────────────────────────────────────────────────────────

function hexToAddress(hex: string): string {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  return "0x" + clean.slice(-40).toLowerCase();
}

function hexToUint256(hex: string): string {
  const clean = hex.startsWith("0x") ? hex : "0x" + hex;
  return BigInt(clean).toString();
}

// ─── Decoder ────────────────────────────────────────────────────────────────

/**
 * Check if a log entry is from the Seaport contract.
 */
export function isSeaportLog(log: WebhookLogEntry): boolean {
  return log.address.toLowerCase() === SEAPORT_ADDRESS;
}

/**
 * Decode a Seaport lifecycle event from a log entry.
 * Returns null if the log is not a recognized Seaport event.
 */
export function decodeSeaportEvent(
  log: WebhookLogEntry,
  chainId: number,
): SeaportLifecycleEvent | null {
  if (!isSeaportLog(log)) return null;

  const topics = log.topics;
  if (!topics || topics.length === 0) return null;

  const topic0 = topics[0].toLowerCase();
  const txHash = log.transactionHash.toLowerCase();
  const blockNumber =
    typeof log.blockNumber === "string"
      ? parseInt(log.blockNumber, log.blockNumber.startsWith("0x") ? 16 : 10)
      : log.blockNumber;

  // OrderFulfilled — topic1 = orderHash, topic2 = offerer (indexed), topic3 = zone (indexed)
  if (topic0 === SEAPORT_EVENTS.ORDER_FULFILLED.toLowerCase()) {
    const orderHash = topics[1]?.toLowerCase();
    if (!orderHash) return null;
    return {
      type: "fulfilled",
      orderHash,
      offerer: topics[2] ? hexToAddress(topics[2]) : undefined,
      txHash,
      chainId,
      blockNumber,
      blockTimestamp: log.blockTimestamp,
    };
  }

  // OrderCancelled — topic1 = orderHash, topic2 = offerer, topic3 = zone
  if (topic0 === SEAPORT_EVENTS.ORDER_CANCELLED.toLowerCase()) {
    const orderHash = topics[1]?.toLowerCase();
    if (!orderHash) return null;
    return {
      type: "cancelled",
      orderHash,
      offerer: topics[2] ? hexToAddress(topics[2]) : undefined,
      txHash,
      chainId,
      blockNumber,
      blockTimestamp: log.blockTimestamp,
    };
  }

  // CounterIncremented — topic1 = newCounter, topic2 = offerer
  if (topic0 === SEAPORT_EVENTS.COUNTER_INCREMENTED.toLowerCase()) {
    if (topics.length < 3) return null;
    return {
      type: "counter_incremented",
      newCounter: topics[1] ? hexToUint256(topics[1]) : undefined,
      offerer: topics[2] ? hexToAddress(topics[2]) : undefined,
      txHash,
      chainId,
      blockNumber,
      blockTimestamp: log.blockTimestamp,
    };
  }

  return null;
}
