/**
 * Watch commands — poll-based monitoring for orders, prices, and collections.
 *
 * Usage:
 *   oob watch order <hash>                          # poll until terminal state
 *   oob watch price --collection 0x... --below 1.5  # alert on floor price threshold
 *   oob watch collection --collection 0x...         # poll for new activity
 */
import { setTimeout as delay } from "node:timers/promises";
import { Command } from "commander";
import { resolveConfig, getLocalOptions } from "../config.js";
import { CliError } from "../errors.js";
import { renderSuccess, emitError, formatKeyValueBlock } from "../output/index.js";
import { createClient } from "../client.js";
import type { RuntimeConfig } from "../types.js";

// ─── Watch Order ─────────────────────────────────────────────────────────────

interface WatchOrderOptions {
  // no extra options, order hash is an argument
}

const TERMINAL_STATUSES = new Set(["filled", "cancelled", "expired"]);

async function runWatchOrder(command: Command, orderHash: string): Promise<void> {
  let config: RuntimeConfig | undefined;
  try {
    config = resolveConfig(command);
    const client = createClient(config);
    const intervalMs = config.intervalMs;
    let iteration = 0;

    process.stderr.write(`[oob] watching order ${orderHash} (interval: ${intervalMs / 1000}s)\n`);

    while (true) {
      iteration++;
      const result = await client.getOrder(orderHash);
      const order = result.order;

      if (!order) {
        renderSuccess("watch order", config, {
          orderHash,
          status: "not_found",
          iteration,
          terminal: false,
          message: "Order not found",
        }, formatKeyValueBlock([
          ["orderHash", orderHash],
          ["status", "not_found"],
          ["iteration", iteration],
        ]));
        break;
      }

      const isTerminal = TERMINAL_STATUSES.has(order.status);

      renderSuccess("watch order", config, {
        orderHash: order.orderHash,
        status: order.status,
        orderType: order.orderType,
        collection: order.nftContract,
        tokenId: order.tokenId,
        priceWei: order.priceWei,
        offerer: order.offerer,
        iteration,
        terminal: isTerminal,
        ...(order.filledTxHash ? { filledTxHash: order.filledTxHash } : {}),
        ...(order.cancelledTxHash ? { cancelledTxHash: order.cancelledTxHash } : {}),
      }, formatKeyValueBlock([
        ["orderHash", order.orderHash],
        ["status", order.status],
        ["iteration", String(iteration)],
        ["terminal", String(isTerminal)],
      ]));

      if (isTerminal) {
        process.stderr.write(`[oob] order reached terminal state: ${order.status}\n`);
        break;
      }

      await delay(intervalMs);
    }
  } catch (error) {
    emitError("watch order", config, error);
  }
}

// ─── Watch Price ─────────────────────────────────────────────────────────────

interface WatchPriceOptions {
  collection: string;
  tokenId?: string;
  below?: string;
  above?: string;
}

function parseEthToWei(ethStr: string): bigint {
  // Handle both ETH (e.g. "1.5") and wei (large integers)
  if (ethStr.includes(".") || Number(ethStr) < 1e12) {
    const parts = ethStr.split(".");
    const whole = parts[0] || "0";
    const frac = (parts[1] || "").padEnd(18, "0").slice(0, 18);
    return BigInt(whole) * BigInt(10) ** BigInt(18) + BigInt(frac);
  }
  return BigInt(ethStr);
}

async function runWatchPrice(command: Command): Promise<void> {
  let config: RuntimeConfig | undefined;
  try {
    config = resolveConfig(command);
    const client = createClient(config);
    const options = getLocalOptions<WatchPriceOptions>(command);

    if (!options.collection) {
      throw new CliError("INVALID_INPUT", 3, "Missing --collection");
    }
    if (!options.below && !options.above) {
      throw new CliError("INVALID_INPUT", 3, "Specify --below and/or --above threshold in ETH or wei");
    }

    const belowWei = options.below ? parseEthToWei(options.below) : undefined;
    const aboveWei = options.above ? parseEthToWei(options.above) : undefined;
    const intervalMs = config.intervalMs;
    let iteration = 0;
    let triggered = false;

    process.stderr.write(`[oob] watching floor price for ${options.collection} (interval: ${intervalMs / 1000}s)\n`);
    if (belowWei) process.stderr.write(`[oob] alert when floor < ${options.below}\n`);
    if (aboveWei) process.stderr.write(`[oob] alert when floor > ${options.above}\n`);

    while (!triggered) {
      iteration++;
      const stats = await client.getCollectionStats(options.collection);
      const floorWei = stats.floorPriceWei ? BigInt(stats.floorPriceWei) : null;

      let alert: string | null = null;
      if (floorWei !== null) {
        if (belowWei && floorWei < belowWei) {
          alert = `Floor price ${stats.floorPriceWei} wei is BELOW threshold ${options.below}`;
          triggered = true;
        }
        if (aboveWei && floorWei > aboveWei) {
          alert = `Floor price ${stats.floorPriceWei} wei is ABOVE threshold ${options.above}`;
          triggered = true;
        }
      }

      const data = {
        collection: options.collection,
        floorPriceWei: stats.floorPriceWei,
        listingCount: stats.listingCount,
        offerCount: stats.offerCount,
        bestOfferWei: stats.bestOfferWei,
        iteration,
        triggered,
        ...(alert ? { alert } : {}),
      };

      renderSuccess("watch price", config, data, formatKeyValueBlock([
        ["collection", options.collection],
        ["floorPriceWei", stats.floorPriceWei ?? "none"],
        ["iteration", String(iteration)],
        ...(alert ? [["ALERT", alert] as [string, unknown]] : []),
      ]));

      if (triggered) {
        process.stderr.write(`[oob] ⚡ ${alert}\n`);
        break;
      }

      await delay(intervalMs);
    }
  } catch (error) {
    emitError("watch price", config, error);
  }
}

// ─── Watch Collection ────────────────────────────────────────────────────────

interface WatchCollectionOptions {
  collection: string;
  events?: string;
}

async function runWatchCollection(command: Command): Promise<void> {
  let config: RuntimeConfig | undefined;
  try {
    config = resolveConfig(command);
    const client = createClient(config);
    const options = getLocalOptions<WatchCollectionOptions>(command);

    if (!options.collection) {
      throw new CliError("INVALID_INPUT", 3, "Missing --collection");
    }

    const intervalMs = config.intervalMs;
    const eventFilter = options.events ? new Set(options.events.split(",").map((e) => e.trim())) : null;
    let lastSeenId = 0;
    let iteration = 0;

    process.stderr.write(`[oob] watching activity for ${options.collection} (interval: ${intervalMs / 1000}s)\n`);

    while (true) {
      iteration++;
      const result = await client.getActivity({
        collection: options.collection,
        limit: 50,
      });

      // Filter to only new events (id > lastSeenId) and optionally by event type
      const newEvents = result.activity.filter((e) => {
        if (e.id <= lastSeenId) return false;
        if (eventFilter && !eventFilter.has(e.eventType)) return false;
        return true;
      });

      if (newEvents.length > 0) {
        // Update watermark
        const maxId = Math.max(...newEvents.map((e) => e.id));
        if (maxId > lastSeenId) lastSeenId = maxId;

        const data = {
          collection: options.collection,
          newEvents: newEvents.length,
          iteration,
          events: newEvents.map((e) => ({
            id: e.id,
            eventType: e.eventType,
            orderHash: e.orderHash,
            priceWei: e.priceWei,
            priceDecimal: e.priceDecimal,
            currencySymbol: e.currencySymbol,
            tokenId: e.tokenId,
            from: e.fromAddress,
            to: e.toAddress,
            txHash: e.txHash,
            createdAt: e.createdAt,
          })),
        };

        renderSuccess("watch collection", config, data, [
          `[${iteration}] ${newEvents.length} new event(s):`,
          ...newEvents.map((e) =>
            `  ${e.eventType} | ${e.orderHash.slice(0, 10)}... | ${e.priceDecimal} ${e.currencySymbol} | ${e.createdAt}`,
          ),
        ]);
      } else if (config.verbose) {
        process.stderr.write(`[verbose] iteration ${iteration}: no new events\n`);
      }

      // On first iteration, just set the watermark from existing events
      if (iteration === 1 && result.activity.length > 0 && lastSeenId === 0) {
        lastSeenId = Math.max(...result.activity.map((e) => e.id));
        if (config.verbose) {
          process.stderr.write(`[verbose] initial watermark set to id=${lastSeenId}\n`);
        }
      }

      await delay(intervalMs);
    }
  } catch (error) {
    emitError("watch collection", config, error);
  }
}

// ─── Registration ────────────────────────────────────────────────────────────

export function registerWatchCommands(program: Command): void {
  const watchCommand = program.command("watch").description("Poll-based monitoring for orders, prices, and collections");

  watchCommand
    .command("order <orderHash>")
    .description("Watch an order until it reaches a terminal state (filled, cancelled, expired)")
    .action(async function (this: Command, orderHash: string) {
      await runWatchOrder(this, orderHash);
    });

  watchCommand
    .command("price")
    .description("Watch collection floor price and alert when threshold is crossed")
    .requiredOption("--collection <address>", "Collection address to watch")
    .option("--token-id <id>", "Specific token ID")
    .option("--below <amount>", "Alert when floor price drops below this value (ETH or wei)")
    .option("--above <amount>", "Alert when floor price rises above this value (ETH or wei)")
    .action(async function (this: Command) {
      await runWatchPrice(this);
    });

  watchCommand
    .command("collection")
    .description("Watch for new activity events on a collection")
    .requiredOption("--collection <address>", "Collection address to watch")
    .option("--events <types>", "Filter event types (comma-separated: listed,offer_placed,filled,cancelled)")
    .action(async function (this: Command) {
      await runWatchCollection(this);
    });

  // Top-level aliases
  program
    .command("watch-order <orderHash>")
    .description("Alias for watch order")
    .action(async function (this: Command, orderHash: string) {
      await runWatchOrder(this, orderHash);
    });

  program
    .command("watch-price")
    .description("Alias for watch price")
    .requiredOption("--collection <address>", "Collection address to watch")
    .option("--below <amount>", "Alert when floor price drops below this value")
    .option("--above <amount>", "Alert when floor price rises above this value")
    .action(async function (this: Command) {
      await runWatchPrice(this);
    });

  program
    .command("watch-collection")
    .description("Alias for watch collection")
    .requiredOption("--collection <address>", "Collection address to watch")
    .option("--events <types>", "Filter event types")
    .action(async function (this: Command) {
      await runWatchCollection(this);
    });
}
