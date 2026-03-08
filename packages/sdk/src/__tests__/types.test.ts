import { describe, it, expect } from "vitest";
import {
  SEAPORT_ADDRESS,
  CONDUIT_CONTROLLER,
  ItemType,
  OrderType,
  SUPPORTED_CHAINS,
  DEFAULT_API_URL,
  DEFAULT_ORIGIN_FEES,
  DEFAULT_ROYALTY_POLICY,
  MAX_ORIGIN_FEE_BPS,
  MAX_ORIGIN_FEE_RECIPIENTS,
  DEFAULT_LISTING_DURATION,
  DEFAULT_OFFER_DURATION,
} from "../types.js";

describe("Constants", () => {
  it("SEAPORT_ADDRESS is correct canonical v1.6 address", () => {
    expect(SEAPORT_ADDRESS).toBe("0x0000000000000068F116a894984e2DB1123eB395");
    expect(SEAPORT_ADDRESS).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  it("CONDUIT_CONTROLLER is a valid address", () => {
    expect(CONDUIT_CONTROLLER).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  it("ItemType has correct Seaport enum values", () => {
    expect(ItemType.NATIVE).toBe(0);
    expect(ItemType.ERC20).toBe(1);
    expect(ItemType.ERC721).toBe(2);
    expect(ItemType.ERC1155).toBe(3);
    expect(ItemType.ERC721_WITH_CRITERIA).toBe(4);
    expect(ItemType.ERC1155_WITH_CRITERIA).toBe(5);
  });

  it("OrderType has correct Seaport enum values", () => {
    expect(OrderType.FULL_OPEN).toBe(0);
    expect(OrderType.PARTIAL_OPEN).toBe(1);
    expect(OrderType.FULL_RESTRICTED).toBe(2);
    expect(OrderType.PARTIAL_RESTRICTED).toBe(3);
  });

  it("SUPPORTED_CHAINS includes expected chains", () => {
    expect(SUPPORTED_CHAINS[1]).toBeDefined();
    expect(SUPPORTED_CHAINS[8453]).toBeDefined();
    expect(SUPPORTED_CHAINS[84532]).toBeDefined();
    expect(SUPPORTED_CHAINS[202601]).toBeDefined();
    expect(SUPPORTED_CHAINS[1].name).toBe("Ethereum");
    expect(SUPPORTED_CHAINS[8453].name).toBe("Base");
    expect(SUPPORTED_CHAINS[8453].nativeSymbol).toBe("ETH");
    expect(SUPPORTED_CHAINS[202601].name).toBe("Ronin Saigon");
  });

  it("DEFAULT_ORIGIN_FEES is empty (origin fee defaults to none)", () => {
    expect(DEFAULT_ORIGIN_FEES).toEqual([]);
  });

  it("MAX_ORIGIN_FEE_RECIPIENTS is 5", () => {
    expect(MAX_ORIGIN_FEE_RECIPIENTS).toBe(5);
  });

  it("DEFAULT_ROYALTY_POLICY is manual_only", () => {
    expect(DEFAULT_ROYALTY_POLICY).toBe("manual_only");
  });

  it("MAX_ORIGIN_FEE_BPS is 500 (5%)", () => {
    expect(MAX_ORIGIN_FEE_BPS).toBe(500);
  });

  it("DEFAULT_LISTING_DURATION is 30 days in seconds", () => {
    expect(DEFAULT_LISTING_DURATION).toBe(30 * 24 * 60 * 60);
  });

  it("DEFAULT_OFFER_DURATION is 7 days in seconds", () => {
    expect(DEFAULT_OFFER_DURATION).toBe(7 * 24 * 60 * 60);
  });

  it("DEFAULT_API_URL is https", () => {
    expect(DEFAULT_API_URL).toMatch(/^https:\/\//);
  });
});
