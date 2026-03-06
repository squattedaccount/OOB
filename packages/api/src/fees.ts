import type { OrderSubmissionMetadata } from "./types.js";

const ETH_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const MAX_ORIGIN_FEE_BPS = 500;

function isValidAddress(addr: string): boolean {
  return ETH_ADDRESS_RE.test(addr);
}

function safeBigInt(val: unknown): bigint {
  try {
    return BigInt(String(val || "0"));
  } catch {
    return 0n;
  }
}

function computeBps(amount: bigint, total: bigint): number {
  if (amount <= 0n || total <= 0n) return 0;
  return Number((amount * 10000n) / total);
}

function normalizeMetadata(
  metadata?: OrderSubmissionMetadata,
): { ok: true; metadata: OrderSubmissionMetadata } | { ok: false; error: string } {
  if (!metadata) return { ok: true, metadata: {} };

  const normalized: OrderSubmissionMetadata = {};
  const originFeeBps = metadata.originFeeBps ?? 0;
  const royaltyBps = metadata.royaltyBps ?? 0;

  if (originFeeBps > 0) {
    if (!metadata.originFeeRecipient || !isValidAddress(metadata.originFeeRecipient)) {
      return { ok: false, error: "metadata.originFeeRecipient is required when metadata.originFeeBps > 0" };
    }
    if (!Number.isInteger(originFeeBps) || originFeeBps < 0 || originFeeBps > MAX_ORIGIN_FEE_BPS) {
      return { ok: false, error: `metadata.originFeeBps must be an integer between 0 and ${MAX_ORIGIN_FEE_BPS}` };
    }
    normalized.originFeeBps = originFeeBps;
    normalized.originFeeRecipient = metadata.originFeeRecipient.toLowerCase();
  }

  if (royaltyBps > 0) {
    if (!metadata.royaltyRecipient || !isValidAddress(metadata.royaltyRecipient)) {
      return { ok: false, error: "metadata.royaltyRecipient is required when metadata.royaltyBps > 0" };
    }
    if (!Number.isInteger(royaltyBps) || royaltyBps < 0 || royaltyBps > 10000) {
      return { ok: false, error: "metadata.royaltyBps must be an integer between 0 and 10000" };
    }
    normalized.royaltyBps = royaltyBps;
    normalized.royaltyRecipient = metadata.royaltyRecipient.toLowerCase();
  }

  if (
    normalized.originFeeRecipient &&
    normalized.royaltyRecipient &&
    normalized.originFeeRecipient === normalized.royaltyRecipient
  ) {
    return { ok: false, error: "metadata.originFeeRecipient and metadata.royaltyRecipient must be different when both are set" };
  }

  return { ok: true, metadata: normalized };
}

export interface ParsedOrderDetails {
  orderType: "listing" | "offer";
  nftContract: string;
  tokenId: string;
  tokenStandard: string;
  priceWei: bigint;
  currency: string;
  protocolFeeRecipient: string;
  protocolFeeBps: number;
  originFeeRecipient: string;
  originFeeBps: number;
  royaltyRecipient: string;
  royaltyBps: number;
}

export function parseOrderDetails(
  order: any,
  offerer: string,
  protocolFeeRecipient: string,
  metadata?: OrderSubmissionMetadata,
): { ok: true; parsed: ParsedOrderDetails } | { ok: false; error: string } {
  const offerItems: any[] = order.offer || [];
  const considerationItems: any[] = order.consideration || [];
  const OOB_FEE = protocolFeeRecipient.toLowerCase();
  const normalizedMetadata = normalizeMetadata(metadata);
  if (!normalizedMetadata.ok) {
    return normalizedMetadata;
  }

  let orderType: "listing" | "offer";
  let nftContract: string;
  let tokenId: string;
  let tokenStandard: string;
  let priceWei: bigint;
  let currency: string;
  let protocolFeeAmount = 0n;
  let protocolFeeRecipientParsed = "";
  const extraRecipientAmounts = new Map<string, bigint>();

  const nftInOffer = offerItems.find((i: any) => Number(i.itemType) === 2 || Number(i.itemType) === 3);
  const nftInConsideration = considerationItems.find((i: any) => Number(i.itemType) === 2 || Number(i.itemType) === 3);

  if (nftInOffer) {
    orderType = "listing";
    nftContract = (nftInOffer.token || "").toLowerCase();
    tokenId = String(nftInOffer.identifierOrCriteria || "0");
    tokenStandard = Number(nftInOffer.itemType) === 2 ? "ERC721" : "ERC1155";
    priceWei = 0n;
    currency = "0x0000000000000000000000000000000000000000";

    for (const item of considerationItems) {
      const it = Number(item.itemType);
      if (it === 0 || it === 1) {
        const amount = safeBigInt(item.startAmount);
        priceWei += amount;
        if (it === 1) currency = (item.token || "").toLowerCase();
        const recipient = (item.recipient || "").toLowerCase();
        if (recipient !== offerer) {
          if (recipient === OOB_FEE) {
            protocolFeeRecipientParsed = recipient;
            protocolFeeAmount += amount;
          } else {
            extraRecipientAmounts.set(recipient, (extraRecipientAmounts.get(recipient) ?? 0n) + amount);
          }
        }
      }
    }
  } else if (nftInConsideration) {
    orderType = "offer";
    nftContract = (nftInConsideration.token || "").toLowerCase();
    tokenId = String(nftInConsideration.identifierOrCriteria || "0");
    tokenStandard = Number(nftInConsideration.itemType) === 2 ? "ERC721" : "ERC1155";
    priceWei = 0n;
    currency = "0x0000000000000000000000000000000000000000";
    for (const item of offerItems) {
      const it = Number(item.itemType);
      if (it === 0 || it === 1) {
        priceWei += safeBigInt(item.startAmount);
        if (it === 1) currency = (item.token || "").toLowerCase();
      }
    }
    for (const item of considerationItems) {
      const it = Number(item.itemType);
      if ((it === 0 || it === 1) && (item.recipient || "").toLowerCase() !== offerer) {
        const recipient = (item.recipient || "").toLowerCase();
        const amount = safeBigInt(item.startAmount);
        if (recipient === OOB_FEE) {
          protocolFeeRecipientParsed = recipient;
          protocolFeeAmount += amount;
        } else {
          extraRecipientAmounts.set(recipient, (extraRecipientAmounts.get(recipient) ?? 0n) + amount);
        }
      }
    }
  } else {
    return { ok: false, error: "Order must contain an NFT in offer or consideration" };
  }

  if (!nftContract || !isValidAddress(nftContract)) {
    return { ok: false, error: "Invalid NFT contract address in order" };
  }
  if (priceWei <= 0n) {
    return { ok: false, error: "Order price must be greater than zero" };
  }

  const protocolFeeBps = computeBps(protocolFeeAmount, priceWei);
  let originFeeRecipient = "";
  let originFeeAmount = 0n;
  let royaltyRecipient = "";
  let royaltyAmount = 0n;

  const consumeRecipient = (recipient: string | undefined, expectedBps: number | undefined, label: "origin fee" | "royalty"):
    { ok: true } | { ok: false; error: string } => {
    if (!recipient || !expectedBps) return { ok: true };
    const amount = extraRecipientAmounts.get(recipient) ?? 0n;
    if (amount <= 0n) {
      return { ok: false, error: `Order metadata declares ${label}, but no matching consideration recipient was found` };
    }
    const actualBps = computeBps(amount, priceWei);
    if (actualBps !== expectedBps) {
      return { ok: false, error: `Order metadata ${label} mismatch: expected ${expectedBps} bps, found ${actualBps} bps` };
    }
    extraRecipientAmounts.delete(recipient);
    if (label === "origin fee") {
      originFeeRecipient = recipient;
      originFeeAmount = amount;
    } else {
      royaltyRecipient = recipient;
      royaltyAmount = amount;
    }
    return { ok: true };
  };

  const metadataResultOrigin = consumeRecipient(
    normalizedMetadata.metadata.originFeeRecipient,
    normalizedMetadata.metadata.originFeeBps,
    "origin fee",
  );
  if (!metadataResultOrigin.ok) return metadataResultOrigin;

  const metadataResultRoyalty = consumeRecipient(
    normalizedMetadata.metadata.royaltyRecipient,
    normalizedMetadata.metadata.royaltyBps,
    "royalty",
  );
  if (!metadataResultRoyalty.ok) return metadataResultRoyalty;

  const remainingRecipients = Array.from(extraRecipientAmounts.entries());
  const hasExplicitMetadata = Boolean(
    normalizedMetadata.metadata.originFeeRecipient ||
    normalizedMetadata.metadata.royaltyRecipient,
  );

  if (remainingRecipients.length > 2) {
    return {
      ok: false,
      error: "Orders with more than two non-protocol fee recipients are not supported yet; submit fewer recipients or wait for multi-recipient support",
    };
  }

  if (remainingRecipients.length === 1 && !hasExplicitMetadata) {
    return {
      ok: false,
      error: "Ambiguous extra fee recipient: submit metadata.originFee* or metadata.royalty* so the order can be classified safely",
    };
  }

  for (const [recipient, amount] of remainingRecipients) {
    if (!originFeeRecipient) {
      originFeeRecipient = recipient;
      originFeeAmount = amount;
      continue;
    }
    if (!royaltyRecipient) {
      royaltyRecipient = recipient;
      royaltyAmount = amount;
    }
  }

  const originFeeBps = computeBps(originFeeAmount, priceWei);
  const royaltyBps = computeBps(royaltyAmount, priceWei);
  if (originFeeBps > MAX_ORIGIN_FEE_BPS) {
    return { ok: false, error: `Origin fee too high: ${originFeeBps} bps (maximum ${MAX_ORIGIN_FEE_BPS} bps)` };
  }

  return {
    ok: true,
    parsed: {
      orderType,
      nftContract,
      tokenId,
      tokenStandard,
      priceWei,
      currency,
      protocolFeeRecipient: protocolFeeRecipientParsed,
      protocolFeeBps,
      originFeeRecipient,
      originFeeBps,
      royaltyRecipient,
      royaltyBps,
    },
  };
}

export function validateFeeEnforcement(
  order: any,
  env: { PROTOCOL_FEE_RECIPIENT: string; PROTOCOL_FEE_BPS?: string },
): string | null {
  const requiredRecipient = (env.PROTOCOL_FEE_RECIPIENT || "").toLowerCase();
  if (!requiredRecipient || !ETH_ADDRESS_RE.test(requiredRecipient)) {
    return "Protocol fee enforcement is not configured";
  }

  const minFeeBps = Number(env.PROTOCOL_FEE_BPS || "33");
  if (!Number.isFinite(minFeeBps) || !Number.isInteger(minFeeBps) || minFeeBps <= 0 || minFeeBps > 10000) {
    return "Protocol fee BPS misconfigured: must be an integer between 1 and 10000";
  }

  const offerItems: any[] = order.offer || [];
  const considerationItems: any[] = order.consideration || [];

  for (const item of [...offerItems, ...considerationItems]) {
    const it = Number(item?.itemType);
    if (it === 0 || it === 1) {
      const start = String(item?.startAmount ?? "0");
      const end = String(item?.endAmount ?? "0");
      if (start !== end) {
        return "Fungible items must have startAmount === endAmount";
      }
    }
  }

  let paymentItemType: number | null = null;
  let paymentToken: string | null = null;
  for (const item of [...offerItems, ...considerationItems]) {
    const it = Number(item?.itemType);
    if (it === 0 || it === 1) {
      const token = (item.token || "0x0000000000000000000000000000000000000000").toLowerCase();
      if (paymentItemType === null) {
        paymentItemType = it;
        paymentToken = token;
      } else if (it !== paymentItemType || token !== paymentToken) {
        return "All fungible items must use the same payment currency";
      }
    }
  }

  const nftInOffer = offerItems.find(
    (i: any) => Number(i.itemType) === 2 || Number(i.itemType) === 3,
  );
  const nftInConsideration = considerationItems.find(
    (i: any) => Number(i.itemType) === 2 || Number(i.itemType) === 3,
  );

  let totalPriceWei = 0n;
  let feeAmountWei = 0n;

  if (nftInOffer) {
    for (const item of considerationItems) {
      const it = Number(item.itemType);
      if (it === 0 || it === 1) {
        totalPriceWei += safeBigInt(item.startAmount);
        if ((item.recipient || "").toLowerCase() === requiredRecipient) {
          feeAmountWei += safeBigInt(item.startAmount);
        }
      }
    }
  } else if (nftInConsideration) {
    for (const item of offerItems) {
      const it = Number(item.itemType);
      if (it === 0 || it === 1) {
        totalPriceWei += safeBigInt(item.startAmount);
      }
    }
    for (const item of considerationItems) {
      const it = Number(item.itemType);
      if ((it === 0 || it === 1) && (item.recipient || "").toLowerCase() === requiredRecipient) {
        feeAmountWei += safeBigInt(item.startAmount);
      }
    }
  }

  if (totalPriceWei <= 0n) {
    return null;
  }

  if (feeAmountWei <= 0n) {
    return `Order must include a fee payment to ${requiredRecipient} (minimum ${minFeeBps / 100}%)`;
  }

  const actualBps = Number((feeAmountWei * 10000n) / totalPriceWei);
  if (actualBps < minFeeBps) {
    return `Fee too low: ${actualBps} bps (minimum ${minFeeBps} bps / ${minFeeBps / 100}%). Fee recipient: ${requiredRecipient}`;
  }

  return null;
}
