/**
 * Seaport v1.6 EIP-712 Order Hash Computation
 *
 * Computes the same order hash that the Seaport contract emits in
 * OrderFulfilled / OrderCancelled events. This is critical for the
 * indexer to match on-chain events to stored orders.
 *
 * Reference: https://github.com/ProjectOpenSea/seaport/blob/main/reference/lib/ReferenceGettersAndDerivers.sol
 */

import { ethers } from "ethers";

// ─── EIP-712 Type Hashes ────────────────────────────────────────────────────

// keccak256("OrderComponents(address offerer,address zone,OfferItem[] offer,ConsiderationItem[] consideration,uint8 orderType,uint256 startTime,uint256 endTime,bytes32 zoneHash,uint256 salt,bytes32 conduitKey,uint256 counter)ConsiderationItem(uint8 itemType,address token,uint256 identifierOrCriteria,uint256 startAmount,uint256 endAmount,address recipient)OfferItem(uint8 itemType,address token,uint256 identifierOrCriteria,uint256 startAmount,uint256 endAmount)")
const ORDER_COMPONENTS_TYPEHASH = ethers.keccak256(
  ethers.toUtf8Bytes(
    "OrderComponents(address offerer,address zone,OfferItem[] offer,ConsiderationItem[] consideration,uint8 orderType,uint256 startTime,uint256 endTime,bytes32 zoneHash,uint256 salt,bytes32 conduitKey,uint256 counter)" +
    "ConsiderationItem(uint8 itemType,address token,uint256 identifierOrCriteria,uint256 startAmount,uint256 endAmount,address recipient)" +
    "OfferItem(uint8 itemType,address token,uint256 identifierOrCriteria,uint256 startAmount,uint256 endAmount)"
  ),
);

// keccak256("OfferItem(uint8 itemType,address token,uint256 identifierOrCriteria,uint256 startAmount,uint256 endAmount)")
const OFFER_ITEM_TYPEHASH = ethers.keccak256(
  ethers.toUtf8Bytes(
    "OfferItem(uint8 itemType,address token,uint256 identifierOrCriteria,uint256 startAmount,uint256 endAmount)"
  ),
);

// keccak256("ConsiderationItem(uint8 itemType,address token,uint256 identifierOrCriteria,uint256 startAmount,uint256 endAmount,address recipient)")
const CONSIDERATION_ITEM_TYPEHASH = ethers.keccak256(
  ethers.toUtf8Bytes(
    "ConsiderationItem(uint8 itemType,address token,uint256 identifierOrCriteria,uint256 startAmount,uint256 endAmount,address recipient)"
  ),
);

const SEAPORT_ADDRESS = "0x0000000000000068F116a894984e2DB1123eB395";
const SEAPORT_NAME = "Seaport";
const SEAPORT_VERSION = "1.6";

// ─── Hash Helpers ───────────────────────────────────────────────────────────

const coder = ethers.AbiCoder.defaultAbiCoder();

function hashOfferItem(item: any): string {
  return ethers.keccak256(
    coder.encode(
      ["bytes32", "uint8", "address", "uint256", "uint256", "uint256"],
      [
        OFFER_ITEM_TYPEHASH,
        Number(item.itemType),
        item.token,
        BigInt(item.identifierOrCriteria || 0),
        BigInt(item.startAmount || 0),
        BigInt(item.endAmount || 0),
      ],
    ),
  );
}

function hashConsiderationItem(item: any): string {
  return ethers.keccak256(
    coder.encode(
      ["bytes32", "uint8", "address", "uint256", "uint256", "uint256", "address"],
      [
        CONSIDERATION_ITEM_TYPEHASH,
        Number(item.itemType),
        item.token,
        BigInt(item.identifierOrCriteria || 0),
        BigInt(item.startAmount || 0),
        BigInt(item.endAmount || 0),
        item.recipient,
      ],
    ),
  );
}

function hashOfferArray(items: any[]): string {
  const hashes = items.map(hashOfferItem);
  return ethers.keccak256(ethers.concat(hashes));
}

function hashConsiderationArray(items: any[]): string {
  const hashes = items.map(hashConsiderationItem);
  return ethers.keccak256(ethers.concat(hashes));
}

// ─── Order Hash ─────────────────────────────────────────────────────────────

/**
 * Compute the EIP-712 struct hash of OrderComponents.
 * This is the `orderHash` that Seaport emits in on-chain events.
 */
function hashOrderComponents(order: any): string {
  return ethers.keccak256(
    coder.encode(
      [
        "bytes32",  // typehash
        "address",  // offerer
        "address",  // zone
        "bytes32",  // offer hash
        "bytes32",  // consideration hash
        "uint8",    // orderType
        "uint256",  // startTime
        "uint256",  // endTime
        "bytes32",  // zoneHash
        "uint256",  // salt
        "bytes32",  // conduitKey
        "uint256",  // counter
      ],
      [
        ORDER_COMPONENTS_TYPEHASH,
        order.offerer,
        order.zone || ethers.ZeroAddress,
        hashOfferArray(order.offer || []),
        hashConsiderationArray(order.consideration || []),
        Number(order.orderType || 0),
        BigInt(order.startTime || 0),
        BigInt(order.endTime || 0),
        order.zoneHash || ethers.ZeroHash,
        BigInt(order.salt || 0),
        order.conduitKey || ethers.ZeroHash,
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
  const domainSeparator = ethers.TypedDataEncoder.hashDomain({
    name: SEAPORT_NAME,
    version: SEAPORT_VERSION,
    chainId,
    verifyingContract: SEAPORT_ADDRESS,
  });

  const structHash = hashOrderComponents(order);

  return ethers.keccak256(
    ethers.concat([
      "0x1901",
      domainSeparator,
      structHash,
    ]),
  );
}
