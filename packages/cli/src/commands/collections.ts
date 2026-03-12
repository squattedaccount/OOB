import { Command } from "commander";
import { formatKeyValueBlock } from "../output/index.js";
import { withConfig } from "../runtime.js";
import type { CollectionStatsResponse } from "../types.js";

function formatCollectionStatsText(result: CollectionStatsResponse): string[] {
  return formatKeyValueBlock([
    ["collection", result.collection],
    ["chainId", result.chainId],
    ["listingCount", result.listingCount],
    ["floorPriceWei", result.floorPriceWei],
    ["offerCount", result.offerCount],
    ["bestOfferWei", result.bestOfferWei],
  ]);
}

async function runCollectionStats(command: Command, commandName: string, collection: string): Promise<void> {
  await withConfig(command, commandName, async (_config, client) => client.getCollectionStats(collection), formatCollectionStatsText);
}

export function registerCollectionsCommands(program: Command): void {
  const collectionsCommand = program.command("collections").description("Read collection-level market data");

  collectionsCommand
    .command("stats <collection>")
    .description("Get collection stats")
    .action(async function (this: Command, collection: string) {
      await runCollectionStats(this, "collections stats", collection);
    });

  program
    .command("stats <collection>")
    .description("Alias for collections stats")
    .action(async function (this: Command, collection: string) {
      await runCollectionStats(this, "stats", collection);
    });
}
