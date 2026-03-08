import type { OrderSubmissionMetadata, OriginFee } from "./types.js";

const ETH_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const MAX_ORIGIN_FEE_BPS = 500;
const MAX_ORIGIN_FEE_RECIPIENTS = 5;

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
  const royaltyBps = metadata.royaltyBps ?? 0;

  if (metadata.originFees && metadata.originFees.length > 0) {
    if (metadata.originFees.length > MAX_ORIGIN_FEE_RECIPIENTS) {
      return { ok: false, error: `metadata.originFees supports at most ${MAX_ORIGIN_FEE_RECIPIENTS} recipients` };
    }

    let totalOriginFeeBps = 0;
    const normalizedOriginFees: OriginFee[] = [];
    for (const originFee of metadata.originFees) {
      if (!originFee?.recipient || !isValidAddress(originFee.recipient)) {
        return { ok: false, error: "metadata.originFees[].recipient must be a valid address" };
      }
      if (!Number.isInteger(originFee.bps) || originFee.bps <= 0 || originFee.bps > MAX_ORIGIN_FEE_BPS) {
        return { ok: false, error: `metadata.originFees[].bps must be an integer between 1 and ${MAX_ORIGIN_FEE_BPS}` };
      }
      totalOriginFeeBps += originFee.bps;
      normalizedOriginFees.push({ recipient: originFee.recipient.toLowerCase(), bps: originFee.bps });
    }

    if (totalOriginFeeBps > MAX_ORIGIN_FEE_BPS) {
      return { ok: false, error: `metadata.originFees total must not exceed ${MAX_ORIGIN_FEE_BPS} bps` };
    }

    normalized.originFees = normalizedOriginFees;
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

  if (normalized.royaltyRecipient && normalized.originFees?.some((originFee) => originFee.recipient === normalized.royaltyRecipient)) {
    return { ok: false, error: "metadata.originFees recipients and metadata.royaltyRecipient must be different when both are set" };
  }

  return { ok: true, metadata: normalized };
}

export interface ParsedOrderDetails {
  orderType: "listing" | "offer";
  nftContract: string;
  tokenId: string;
  assetScope: "token" | "collection" | "criteria";
  identifierOrCriteria: string;
  tokenStandard: string;
  priceWei: bigint;
  currency: string;
  protocolFeeRecipient: string;
  protocolFeeBps: number;
  originFees: OriginFee[];
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
  let assetScope: "token" | "collection" | "criteria";
  let identifierOrCriteria: string;
  let tokenStandard: string;
  let priceWei: bigint;
  let currency: string;
  let protocolFeeAmount = 0n;
  let protocolFeeRecipientParsed = "";
  const extraRecipientAmounts = new Map<string, bigint>();

  const nftInOffer = offerItems.find((i: any) => [2, 3, 4, 5].includes(Number(i.itemType)));
  const nftInConsideration = considerationItems.find((i: any) => [2, 3, 4, 5].includes(Number(i.itemType)));

  const resolveAssetScope = (itemType: number, identifierRaw: any) => {
    const identifier = String(identifierRaw || "0");
    if (itemType === 2 || itemType === 3) {
      return {
        assetScope: "token" as const,
        tokenId: identifier,
        identifierOrCriteria: identifier,
        tokenStandard: itemType === 2 ? "ERC721" : "ERC1155",
      };
    }

    return {
      assetScope: identifier === "0" ? "collection" as const : "criteria" as const,
      tokenId: "0",
      identifierOrCriteria: identifier,
      tokenStandard: itemType === 4 ? "ERC721" : "ERC1155",
    };
  };

  if (nftInOffer) {
    orderType = "listing";
    nftContract = (nftInOffer.token || "").toLowerCase();
    ({ tokenId, assetScope, identifierOrCriteria, tokenStandard } = resolveAssetScope(
      Number(nftInOffer.itemType),
      nftInOffer.identifierOrCriteria,
    ));
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
    ({ tokenId, assetScope, identifierOrCriteria, tokenStandard } = resolveAssetScope(
      Number(nftInConsideration.itemType),
      nftInConsideration.identifierOrCriteria,
    ));
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
  const originFees: OriginFee[] = [];
  let originFeeAmount = 0n;
  let royaltyRecipient = "";
  let royaltyAmount = 0n;
  if (normalizedMetadata.metadata.originFees) {
    for (const declaredOriginFee of normalizedMetadata.metadata.originFees) {
      const amount = extraRecipientAmounts.get(declaredOriginFee.recipient) ?? 0n;
      if (amount <= 0n) {
        return { ok: false, error: "Order metadata declares origin fee, but no matching consideration recipient was found" };
      }
      const actualBps = computeBps(amount, priceWei);
      if (actualBps !== declaredOriginFee.bps) {
        return { ok: false, error: `Order metadata origin fee mismatch for ${declaredOriginFee.recipient}: expected ${declaredOriginFee.bps} bps, found ${actualBps} bps` };
      }
      extraRecipientAmounts.delete(declaredOriginFee.recipient);
      originFees.push(declaredOriginFee);
      originFeeAmount += amount;
    }
  }

  if (normalizedMetadata.metadata.royaltyRecipient && normalizedMetadata.metadata.royaltyBps) {
    const amount = extraRecipientAmounts.get(normalizedMetadata.metadata.royaltyRecipient) ?? 0n;
    if (amount <= 0n) {
      return { ok: false, error: "Order metadata declares royalty, but no matching consideration recipient was found" };
    }
    const actualBps = computeBps(amount, priceWei);
    if (actualBps !== normalizedMetadata.metadata.royaltyBps) {
      return { ok: false, error: `Order metadata royalty mismatch: expected ${normalizedMetadata.metadata.royaltyBps} bps, found ${actualBps} bps` };
    }
    extraRecipientAmounts.delete(normalizedMetadata.metadata.royaltyRecipient);
    royaltyRecipient = normalizedMetadata.metadata.royaltyRecipient;
    royaltyAmount = amount;
  }

  const remainingRecipients = Array.from(extraRecipientAmounts.entries());
  const hasExplicitMetadata = Boolean(
    normalizedMetadata.metadata.originFees?.length ||
    normalizedMetadata.metadata.royaltyRecipient,
  );

  if (remainingRecipients.length > 1) {
    return {
      ok: false,
      error: "Orders with unclassified extra fee recipients are not supported; submit explicit metadata for all origin fee recipients and royalty",
    };
  }

  if (remainingRecipients.length === 1 && !hasExplicitMetadata) {
    return {
      ok: false,
      error: "Ambiguous extra fee recipient: submit metadata.originFees or metadata.royalty* so the order can be classified safely",
    };
  }

  for (const [recipient, amount] of remainingRecipients) {
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
      assetScope,
      identifierOrCriteria,
      tokenStandard,
      priceWei,
      currency,
      protocolFeeRecipient: protocolFeeRecipientParsed,
      protocolFeeBps,
      originFees,
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
