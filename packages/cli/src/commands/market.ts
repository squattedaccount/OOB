import { Command } from "commander";
import type { CliApiClient } from "../client.js";
import { getLocalOptions } from "../config.js";
import { formatKeyValueBlock } from "../output/index.js";
import { withConfig } from "../runtime.js";
import type { MarketSnapshotData, MarketTargetOptions, OobOrder, TokenSummaryData } from "../types.js";
import { normalizeRequiredString } from "../utils.js";

function getSpreadWei(bestListing: OobOrder | null, bestOffer: OobOrder | null): string | null {
  if (!bestListing?.priceWei || !bestOffer?.priceWei) {
    return null;
  }

  try {
    return (BigInt(bestListing.priceWei) - BigInt(bestOffer.priceWei)).toString();
  } catch {
    return null;
  }
}

export async function getMarketSnapshotData(client: CliApiClient, collection: string): Promise<MarketSnapshotData> {
  const [stats, bestListingRes, bestOfferRes] = await Promise.all([
    client.getCollectionStats(collection),
    client.getBestListing({ collection }),
    client.getBestOffer({ collection }),
  ]);

  return {
    bestListing: bestListingRes.order,
    bestOffer: bestOfferRes.order,
    collection: stats.collection,
    floorPriceWei: stats.floorPriceWei,
    listingCount: stats.listingCount,
    offerCount: stats.offerCount,
    spreadWei: getSpreadWei(bestListingRes.order, bestOfferRes.order),
  };
}

export async function getTokenSummaryData(client: CliApiClient, collection: string, tokenId: string): Promise<TokenSummaryData> {
  const [bestListingRes, bestOfferRes, orders] = await Promise.all([
    client.getBestListing({ collection, tokenId }),
    client.getBestOffer({ collection, tokenId }),
    client.getOrders({ collection, tokenId, status: "active", limit: 100 }),
  ]);

  const offerCount = orders.orders.filter((order) => order.orderType === "offer").length;

  return {
    bestListing: bestListingRes.order,
    bestOffer: bestOfferRes.order,
    collection,
    offerCount,
    tokenId,
    totalOrders: orders.total,
  };
}

function formatMarketSnapshotText(result: MarketSnapshotData): string[] {
  return formatKeyValueBlock([
    ["collection", result.collection],
    ["listingCount", result.listingCount],
    ["offerCount", result.offerCount],
    ["floorPriceWei", result.floorPriceWei],
    ["bestListingWei", result.bestListing?.priceWei ?? null],
    ["bestOfferWei", result.bestOffer?.priceWei ?? null],
    ["spreadWei", result.spreadWei],
  ]);
}

function formatTokenSummaryText(result: TokenSummaryData): string[] {
  return formatKeyValueBlock([
    ["collection", result.collection],
    ["tokenId", result.tokenId],
    ["totalOrders", result.totalOrders],
    ["offerCount", result.offerCount],
    ["bestListingWei", result.bestListing?.priceWei ?? null],
    ["bestOfferWei", result.bestOffer?.priceWei ?? null],
  ]);
}

async function runMarketSnapshot(command: Command, commandName: string): Promise<void> {
  await withConfig(command, commandName, async (_config, client) => {
    const options = getLocalOptions<MarketTargetOptions>(command);
    return getMarketSnapshotData(client, options.collection);
  }, formatMarketSnapshotText);
}

async function runTokenSummary(command: Command, commandName: string): Promise<void> {
  await withConfig(command, commandName, async (_config, client) => {
    const options = getLocalOptions<MarketTargetOptions>(command);
    const tokenId = normalizeRequiredString(options.tokenId, "tokenId");
    return getTokenSummaryData(client, options.collection, tokenId);
  }, formatTokenSummaryText);
}

export function registerMarketCommands(program: Command): void {
  const marketCommand = program.command("market").description("Read higher-level market summaries");

  marketCommand
    .command("snapshot")
    .description("Get a collection-level market snapshot")
    .requiredOption("--collection <address>", "Collection address")
    .action(async function (this: Command) {
      await runMarketSnapshot(this, "market snapshot");
    });

  marketCommand
    .command("token-summary")
    .description("Get a token-level market summary")
    .requiredOption("--collection <address>", "Collection address")
    .requiredOption("--token-id <tokenId>", "Token ID")
    .action(async function (this: Command) {
      await runTokenSummary(this, "market token-summary");
    });

  program
    .command("snapshot")
    .description("Alias for market snapshot")
    .requiredOption("--collection <address>", "Collection address")
    .action(async function (this: Command) {
      await runMarketSnapshot(this, "snapshot");
    });

  program
    .command("token-summary")
    .description("Alias for market token-summary")
    .requiredOption("--collection <address>", "Collection address")
    .requiredOption("--token-id <tokenId>", "Token ID")
    .action(async function (this: Command) {
      await runTokenSummary(this, "token-summary");
    });
}
