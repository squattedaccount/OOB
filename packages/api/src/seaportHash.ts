/**
 * Seaport v1.6 EIP-712 Order Hash Computation
 *
 * Computes the same order hash that the Seaport contract emits in
 * OrderFulfilled / OrderCancelled events. This is critical for the
 * indexer to match on-chain events to stored orders.
 *
 * Reference: https://github.com/ProjectOpenSea/seaport/blob/main/reference/lib/ReferenceGettersAndDerivers.sol
 */

import {
  keccak256,
  toHex,
  concat,
  encodeAbiParameters,
  type Address,
  type Hex,
} from "viem";

// ─── EIP-712 Type Hashes ────────────────────────────────────────────────────

// keccak256("OrderComponents(address offerer,address zone,OfferItem[] offer,ConsiderationItem[] consideration,uint8 orderType,uint256 startTime,uint256 endTime,bytes32 zoneHash,uint256 salt,bytes32 conduitKey,uint256 counter)ConsiderationItem(uint8 itemType,address token,uint256 identifierOrCriteria,uint256 startAmount,uint256 endAmount,address recipient)OfferItem(uint8 itemType,address token,uint256 identifierOrCriteria,uint256 startAmount,uint256 endAmount)")
const ORDER_COMPONENTS_TYPEHASH = keccak256(
  toHex(
    "OrderComponents(address offerer,address zone,OfferItem[] offer,ConsiderationItem[] consideration,uint8 orderType,uint256 startTime,uint256 endTime,bytes32 zoneHash,uint256 salt,bytes32 conduitKey,uint256 counter)" +
    "ConsiderationItem(uint8 itemType,address token,uint256 identifierOrCriteria,uint256 startAmount,uint256 endAmount,address recipient)" +
    "OfferItem(uint8 itemType,address token,uint256 identifierOrCriteria,uint256 startAmount,uint256 endAmount)"
  ),
);

// keccak256("OfferItem(uint8 itemType,address token,uint256 identifierOrCriteria,uint256 startAmount,uint256 endAmount)")
const OFFER_ITEM_TYPEHASH = keccak256(
  toHex(
    "OfferItem(uint8 itemType,address token,uint256 identifierOrCriteria,uint256 startAmount,uint256 endAmount)"
  ),
);

// keccak256("ConsiderationItem(uint8 itemType,address token,uint256 identifierOrCriteria,uint256 startAmount,uint256 endAmount,address recipient)")
const CONSIDERATION_ITEM_TYPEHASH = keccak256(
  toHex(
    "ConsiderationItem(uint8 itemType,address token,uint256 identifierOrCriteria,uint256 startAmount,uint256 endAmount,address recipient)"
  ),
);

const SEAPORT_ADDRESS: Address = "0x0000000000000068F116a894984e2DB1123eB395";
const SEAPORT_NAME = "Seaport";
const SEAPORT_VERSION = "1.6";

const ZERO_ADDRESS: Address = "0x0000000000000000000000000000000000000000";
const ZERO_HASH: Hex = "0x0000000000000000000000000000000000000000000000000000000000000000";

// ─── Hash Helpers ───────────────────────────────────────────────────────────

function hashOfferItem(item: any): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" }, { type: "uint8" }, { type: "address" },
        { type: "uint256" }, { type: "uint256" }, { type: "uint256" },
      ],
      [
        OFFER_ITEM_TYPEHASH,
        Number(item.itemType),
        item.token as Address,
        BigInt(item.identifierOrCriteria || 0),
        BigInt(item.startAmount || 0),
        BigInt(item.endAmount || 0),
      ],
    ),
  );
}

function hashConsiderationItem(item: any): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" }, { type: "uint8" }, { type: "address" },
        { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "address" },
      ],
      [
        CONSIDERATION_ITEM_TYPEHASH,
        Number(item.itemType),
        item.token as Address,
        BigInt(item.identifierOrCriteria || 0),
        BigInt(item.startAmount || 0),
        BigInt(item.endAmount || 0),
        item.recipient as Address,
      ],
    ),
  );
}

function hashOfferArray(items: any[]): Hex {
  const hashes = items.map(hashOfferItem);
  return keccak256(concat(hashes));
}

function hashConsiderationArray(items: any[]): Hex {
  const hashes = items.map(hashConsiderationItem);
  return keccak256(concat(hashes));
}

// ─── Order Hash ─────────────────────────────────────────────────────────────

/**
 * Compute the EIP-712 struct hash of OrderComponents.
 * This is the `orderHash` that Seaport emits in on-chain events.
 */
function hashOrderComponents(order: any): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" },  // typehash
        { type: "address" },  // offerer
        { type: "address" },  // zone
        { type: "bytes32" },  // offer hash
        { type: "bytes32" },  // consideration hash
        { type: "uint8" },    // orderType
        { type: "uint256" },  // startTime
        { type: "uint256" },  // endTime
        { type: "bytes32" },  // zoneHash
        { type: "uint256" },  // salt
        { type: "bytes32" },  // conduitKey
        { type: "uint256" },  // counter
      ],
      [
        ORDER_COMPONENTS_TYPEHASH,
        order.offerer as Address,
        (order.zone || ZERO_ADDRESS) as Address,
        hashOfferArray(order.offer || []),
        hashConsiderationArray(order.consideration || []),
        Number(order.orderType || 0),
        BigInt(order.startTime || 0),
        BigInt(order.endTime || 0),
        (order.zoneHash || ZERO_HASH) as Hex,
        BigInt(order.salt || 0),
        (order.conduitKey || ZERO_HASH) as Hex,
        BigInt(order.counter || 0),
      ],
    ),
  );
}

/**
 * Compute the full EIP-712 order hash (domain-separated).
 * This matches what Seaport uses on-chain for event emission.
 *
 * orderHash = keccak256("\x19\x01" || domainSeparator || structHash)
 */
export function computeOrderHash(order: any, chainId: number): string {
  // hashTypedData from viem/utils computes the domain separator
  // We need just the domain separator, so we compute it manually
  const domainSeparator = keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" }, // typeHash
        { type: "bytes32" }, // nameHash
        { type: "bytes32" }, // versionHash
        { type: "uint256" }, // chainId
        { type: "address" }, // verifyingContract
      ],
      [
        keccak256(toHex("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)")),
        keccak256(toHex(SEAPORT_NAME)),
        keccak256(toHex(SEAPORT_VERSION)),
        BigInt(chainId),
        SEAPORT_ADDRESS,
      ],
    ),
  );

  const structHash = hashOrderComponents(order);

  return keccak256(
    concat([
      "0x1901",
      domainSeparator,
      structHash,
    ]),
  );
}
