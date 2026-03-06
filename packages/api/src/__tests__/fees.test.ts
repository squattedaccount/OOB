import { describe, it, expect } from "vitest";
import { parseOrderDetails, validateFeeEnforcement } from "../fees.js";

const OFFERER = "0x1111111111111111111111111111111111111111";
const PROTOCOL = "0x0000000000000000000000000000000000000001";
const ORIGIN = "0x2222222222222222222222222222222222222222";
const ROYALTY = "0x3333333333333333333333333333333333333333";
const NFT = "0x4444444444444444444444444444444444444444";
const ERC20 = "0x5555555555555555555555555555555555555555";

function erc721OfferItem() {
  return {
    itemType: 2,
    token: NFT,
    identifierOrCriteria: "42",
    startAmount: "1",
    endAmount: "1",
  };
}

function nativeItem(amount: string, recipient: string) {
  return {
    itemType: 0,
    token: "0x0000000000000000000000000000000000000000",
    identifierOrCriteria: "0",
    startAmount: amount,
    endAmount: amount,
    recipient,
  };
}

function erc20Item(amount: string, recipient: string) {
  return {
    itemType: 1,
    token: ERC20,
    identifierOrCriteria: "0",
    startAmount: amount,
    endAmount: amount,
    recipient,
  };
}

function listingOrder(extraConsideration: any[] = [], sellerAmount = "9967") {
  return {
    offer: [erc721OfferItem()],
    consideration: [
      nativeItem(sellerAmount, OFFERER),
      nativeItem("33", PROTOCOL),
      ...extraConsideration,
    ],
    orderType: 0,
  };
}

function offerOrder(extraConsideration: any[] = []) {
  return {
    offer: [
      {
        itemType: 1,
        token: ERC20,
        identifierOrCriteria: "0",
        startAmount: "10000",
        endAmount: "10000",
      },
    ],
    consideration: [
      erc721OfferItem(),
      erc20Item("33", PROTOCOL),
      ...extraConsideration,
    ],
    orderType: 0,
  };
}

describe("fee parsing", () => {
  it("parses listing with protocol fee only", () => {
    const result = parseOrderDetails(listingOrder(), OFFERER.toLowerCase(), PROTOCOL);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.parsed.orderType).toBe("listing");
    expect(result.parsed.priceWei).toBe(10000n);
    expect(result.parsed.protocolFeeBps).toBe(33);
    expect(result.parsed.protocolFeeRecipient).toBe(PROTOCOL.toLowerCase());
    expect(result.parsed.originFeeBps).toBe(0);
    expect(result.parsed.royaltyBps).toBe(0);
  });

  it("parses listing with protocol plus origin fee", () => {
    const result = parseOrderDetails(
      listingOrder([nativeItem("100", ORIGIN)], "9867"),
      OFFERER.toLowerCase(),
      PROTOCOL,
      { originFeeRecipient: ORIGIN, originFeeBps: 100 },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.parsed.originFeeRecipient).toBe(ORIGIN.toLowerCase());
    expect(result.parsed.originFeeBps).toBe(100);
    expect(result.parsed.royaltyBps).toBe(0);
  });

  it("rejects ambiguous single extra listing recipient without metadata", () => {
    const result = parseOrderDetails(listingOrder([nativeItem("500", ROYALTY)], "9467"), OFFERER.toLowerCase(), PROTOCOL);
    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error).toContain("Ambiguous extra fee recipient");
  });

  it("uses submission metadata to classify a single extra listing recipient as royalty", () => {
    const result = parseOrderDetails(
      listingOrder([nativeItem("500", ROYALTY)], "9467"),
      OFFERER.toLowerCase(),
      PROTOCOL,
      { royaltyRecipient: ROYALTY, royaltyBps: 500 },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.parsed.originFeeRecipient).toBe("");
    expect(result.parsed.originFeeBps).toBe(0);
    expect(result.parsed.royaltyRecipient).toBe(ROYALTY.toLowerCase());
    expect(result.parsed.royaltyBps).toBe(500);
  });

  it("parses listing with protocol plus origin plus royalty when there are distinct extra recipients", () => {
    const result = parseOrderDetails(
      listingOrder([nativeItem("100", ORIGIN), nativeItem("500", ROYALTY)], "9367"),
      OFFERER.toLowerCase(),
      PROTOCOL,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.parsed.originFeeRecipient).toBe(ORIGIN.toLowerCase());
    expect(result.parsed.originFeeBps).toBe(100);
    expect(result.parsed.royaltyRecipient).toBe(ROYALTY.toLowerCase());
    expect(result.parsed.royaltyBps).toBe(500);
  });

  it("parses offer with protocol fee only", () => {
    const result = parseOrderDetails(offerOrder(), OFFERER.toLowerCase(), PROTOCOL);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.parsed.orderType).toBe("offer");
    expect(result.parsed.priceWei).toBe(10000n);
    expect(result.parsed.currency).toBe(ERC20.toLowerCase());
    expect(result.parsed.protocolFeeBps).toBe(33);
    expect(result.parsed.originFeeBps).toBe(0);
    expect(result.parsed.royaltyBps).toBe(0);
  });

  it("parses offer with protocol plus origin fee", () => {
    const result = parseOrderDetails(
      offerOrder([erc20Item("100", ORIGIN)]),
      OFFERER.toLowerCase(),
      PROTOCOL,
      { originFeeRecipient: ORIGIN, originFeeBps: 100 },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.parsed.originFeeRecipient).toBe(ORIGIN.toLowerCase());
    expect(result.parsed.originFeeBps).toBe(100);
    expect(result.parsed.royaltyBps).toBe(0);
  });

  it("rejects ambiguous single extra offer recipient without metadata", () => {
    const result = parseOrderDetails(offerOrder([erc20Item("500", ROYALTY)]), OFFERER.toLowerCase(), PROTOCOL);
    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error).toContain("Ambiguous extra fee recipient");
  });

  it("rejects orders with more than two non-protocol extra recipients", () => {
    const result = parseOrderDetails(
      listingOrder([
        nativeItem("100", ORIGIN),
        nativeItem("200", ROYALTY),
        nativeItem("50", "0x6666666666666666666666666666666666666666"),
      ], "9617"),
      OFFERER.toLowerCase(),
      PROTOCOL,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error).toContain("more than two non-protocol fee recipients");
  });

  it("uses submission metadata to classify a single extra offer recipient as royalty", () => {
    const result = parseOrderDetails(
      offerOrder([erc20Item("500", ROYALTY)]),
      OFFERER.toLowerCase(),
      PROTOCOL,
      { royaltyRecipient: ROYALTY, royaltyBps: 500 },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.parsed.originFeeRecipient).toBe("");
    expect(result.parsed.originFeeBps).toBe(0);
    expect(result.parsed.royaltyRecipient).toBe(ROYALTY.toLowerCase());
    expect(result.parsed.royaltyBps).toBe(500);
  });

  it("parses offer with protocol plus origin plus royalty when there are distinct extra recipients", () => {
    const result = parseOrderDetails(
      offerOrder([erc20Item("100", ORIGIN), erc20Item("500", ROYALTY)]),
      OFFERER.toLowerCase(),
      PROTOCOL,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.parsed.originFeeRecipient).toBe(ORIGIN.toLowerCase());
    expect(result.parsed.originFeeBps).toBe(100);
    expect(result.parsed.royaltyRecipient).toBe(ROYALTY.toLowerCase());
    expect(result.parsed.royaltyBps).toBe(500);
  });

  it("rejects metadata when declared royalty does not match order contents", () => {
    const result = parseOrderDetails(
      listingOrder([nativeItem("500", ROYALTY)], "9467"),
      OFFERER.toLowerCase(),
      PROTOCOL,
      { royaltyRecipient: ROYALTY, royaltyBps: 400 },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error).toContain("metadata royalty mismatch");
  });
});

describe("fee enforcement", () => {
  it("accepts listing with required protocol fee", () => {
    const error = validateFeeEnforcement(listingOrder(), {
      PROTOCOL_FEE_RECIPIENT: PROTOCOL,
      PROTOCOL_FEE_BPS: "33",
    });
    expect(error).toBeNull();
  });

  it("accepts offer with required protocol fee", () => {
    const error = validateFeeEnforcement(offerOrder(), {
      PROTOCOL_FEE_RECIPIENT: PROTOCOL,
      PROTOCOL_FEE_BPS: "33",
    });
    expect(error).toBeNull();
  });

  it("rejects fee below minimum bps", () => {
    const error = validateFeeEnforcement(listingOrder(), {
      PROTOCOL_FEE_RECIPIENT: PROTOCOL,
      PROTOCOL_FEE_BPS: "50",
    });
    expect(error).toContain("Fee too low");
  });
});
