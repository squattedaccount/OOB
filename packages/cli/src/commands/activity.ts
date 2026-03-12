import { Command } from "commander";
import { getLocalOptions, parseNumber } from "../config.js";
import { formatKeyValueBlock } from "../output/index.js";
import { withConfig } from "../runtime.js";
import type { ActivityEvent, ActivityResponse } from "../types.js";

interface ActivityListOptions {
  collection?: string;
  tokenId?: string;
  eventType?: string;
  address?: string;
  orderHash?: string;
  limit?: string;
  offset?: string;
}

function formatActivityListText(result: ActivityResponse): string[] {
  if (result.activity.length === 0) {
    return ["No activity found"];
  }
  const lines: string[] = [`total: ${result.total}`];
  for (const event of result.activity) {
    lines.push(`${event.createdAt} ${event.eventType} ${event.orderHash} ${event.priceDecimal} ${event.currencySymbol}`);
  }
  return lines;
}

function formatActivityEventText(event: ActivityEvent): string[] {
  return formatKeyValueBlock([
    ["eventType", event.eventType],
    ["orderHash", event.orderHash],
    ["chainId", event.chainId],
    ["fromAddress", event.fromAddress],
    ["toAddress", event.toAddress],
    ["nftContract", event.nftContract],
    ["tokenId", event.tokenId],
    ["priceWei", event.priceWei],
    ["priceDecimal", event.priceDecimal],
    ["currencySymbol", event.currencySymbol],
    ["txHash", event.txHash],
    ["createdAt", event.createdAt],
  ]);
}

function formatActivityOrderText(result: ActivityResponse): string[] {
  if (result.activity.length === 0) {
    return ["No activity found for this order"];
  }
  const lines: string[] = [`total: ${result.total}`];
  for (const event of result.activity) {
    lines.push("---");
    lines.push(...formatActivityEventText(event));
  }
  return lines;
}

async function runActivityList(command: Command, commandName: string): Promise<void> {
  await withConfig(command, commandName, async (_config, client) => {
    const options = getLocalOptions<ActivityListOptions>(command);
    return client.getActivity({
      orderHash: options.orderHash,
      collection: options.collection,
      tokenId: options.tokenId,
      eventType: options.eventType,
      address: options.address,
      limit: options.limit ? parseNumber(options.limit, "limit") : undefined,
      offset: options.offset ? parseNumber(options.offset, "offset") : undefined,
    });
  }, formatActivityListText);
}

async function runActivityOrder(command: Command, commandName: string, orderHash: string): Promise<void> {
  await withConfig(command, commandName, async (_config, client) => {
    return client.getOrderActivity(orderHash);
  }, formatActivityOrderText);
}

export function registerActivityCommands(program: Command): void {
  const activityCommand = program.command("activity").description("Query order activity and event history");

  activityCommand
    .command("list")
    .description("List activity events with optional filters")
    .option("--collection <address>", "Filter by collection address")
    .option("--token-id <tokenId>", "Filter by token ID")
    .option("--event-type <type>", "Filter by event type: listed, offer_placed, filled, cancelled, expired, stale")
    .option("--address <address>", "Filter by from or to address")
    .option("--order-hash <hash>", "Filter by order hash")
    .option("--limit <number>", "Max results (1-200, default 50)")
    .option("--offset <number>", "Pagination offset")
    .action(async function (this: Command) {
      await runActivityList(this, "activity list");
    });

  activityCommand
    .command("order <orderHash>")
    .description("Get activity events for a specific order")
    .action(async function (this: Command, orderHash: string) {
      await runActivityOrder(this, "activity order", orderHash);
    });

  // Compatibility aliases
  program
    .command("activity-list")
    .description("Compatibility alias for activity list")
    .option("--collection <address>", "Filter by collection address")
    .option("--token-id <tokenId>", "Filter by token ID")
    .option("--event-type <type>", "Filter by event type")
    .option("--address <address>", "Filter by from or to address")
    .option("--order-hash <hash>", "Filter by order hash")
    .option("--limit <number>", "Max results")
    .option("--offset <number>", "Pagination offset")
    .action(async function (this: Command) {
      await runActivityList(this, "activity list");
    });

  program
    .command("activity-order <orderHash>")
    .description("Compatibility alias for activity order")
    .action(async function (this: Command, orderHash: string) {
      await runActivityOrder(this, "activity order", orderHash);
    });
}
