import { Command } from "commander";
import { getLocalOptions, parseNumber } from "../config.js";
import { formatKeyValueBlock } from "../output/index.js";
import { withConfig } from "../runtime.js";
import type {
  BestOrderOptions,
  FillTxResponse,
  OobOrder,
  OrdersListOptions,
  OrdersResponse,
  OrderStatus,
  OrderType,
  SingleOrderResponse,
  SortBy,
} from "../types.js";

interface FillTxOptions {
  buyer: string;
  validate?: boolean;
  tipRecipient?: string;
  tipBps?: string;
}

interface FloorTxOptions extends BestOrderOptions {
  buyer: string;
  validate?: boolean;
  tipRecipient?: string;
  tipBps?: string;
}

function formatOrdersListText(result: OrdersResponse): string[] {
  const lines = [`total: ${result.total}`];
  for (const order of result.orders) {
    lines.push(`${order.orderHash} ${order.orderType} ${order.priceWei} ${order.status}`);
  }
  return lines;
}

function formatOrderResultText(result: { order: OobOrder | null }): string[] {
  return result.order
    ? formatKeyValueBlock([
        ["orderHash", result.order.orderHash],
        ["orderType", result.order.orderType],
        ["status", result.order.status],
        ["priceWei", result.order.priceWei],
        ["collection", result.order.nftContract],
        ["tokenId", result.order.tokenId],
      ])
    : ["order: not found"];
}

function formatBestOrderText(result: { order: OobOrder | null }): string[] {
  return result.order
    ? formatKeyValueBlock([
        ["orderHash", result.order.orderHash],
        ["priceWei", result.order.priceWei],
        ["collection", result.order.nftContract],
        ["tokenId", result.order.tokenId],
      ])
    : ["order: not found"];
}

function formatFillTxText(result: FillTxResponse): string[] {
  const entries: Array<[string, unknown]> = [
    ["to", result.to],
    ["data", result.data],
    ["value", result.value],
    ["chainId", result.chainId],
    ["orderHash", result.orderHash],
    ["nftContract", result.nftContract],
    ["tokenId", result.tokenId],
    ["priceWei", result.priceWei],
    ["priceDecimal", result.priceDecimal],
    ["currencySymbol", result.currencySymbol],
    ["expiresAt", result.expiresAt],
  ];
  if (result.warning) {
    entries.push(["warning", result.warning]);
  }
  return formatKeyValueBlock(entries);
}

async function runOrdersList(command: Command, commandName: string): Promise<void> {
  await withConfig(command, commandName, async (_config, client) => {
    const options = getLocalOptions<OrdersListOptions>(command);
    return client.getOrders({
      collection: options.collection,
      tokenId: options.tokenId,
      type: options.type as OrderType | undefined,
      offerer: options.offerer,
      status: options.status as OrderStatus | undefined,
      sortBy: options.sortBy as SortBy | undefined,
      limit: options.limit ? parseNumber(options.limit, "limit") : undefined,
      offset: options.offset ? parseNumber(options.offset, "offset") : undefined,
    });
  }, formatOrdersListText);
}

async function runOrderGet(command: Command, commandName: string, orderHash: string): Promise<void> {
  await withConfig(command, commandName, async (_config, client) => ({
    order: (await client.getOrder(orderHash)).order,
  }), formatOrderResultText);
}

async function runBestOrder(command: Command, commandName: string, side: "listing" | "offer"): Promise<void> {
  await withConfig(command, commandName, async (_config, client) => {
    const options = getLocalOptions<BestOrderOptions>(command);
    const order = side === "listing"
      ? (await client.getBestListing({ collection: options.collection, tokenId: options.tokenId })).order
      : (await client.getBestOffer({ collection: options.collection, tokenId: options.tokenId })).order;
    return { order };
  }, formatBestOrderText);
}

async function runFillTx(command: Command, commandName: string, orderHash: string): Promise<void> {
  await withConfig(command, commandName, async (_config, client) => {
    const options = getLocalOptions<FillTxOptions>(command);
    return client.getFillTx(orderHash, options.buyer, {
      validate: options.validate,
      tipRecipient: options.tipRecipient,
      tipBps: options.tipBps ? Number(options.tipBps) : undefined,
    });
  }, formatFillTxText);
}

async function runFloorTx(command: Command, commandName: string): Promise<void> {
  await withConfig(command, commandName, async (_config, client) => {
    const options = getLocalOptions<FloorTxOptions>(command);
    return client.getBestListingFillTx({
      collection: options.collection,
      tokenId: options.tokenId,
      buyer: options.buyer,
      tipRecipient: options.tipRecipient,
      tipBps: options.tipBps ? Number(options.tipBps) : undefined,
    });
  }, formatFillTxText);
}

function addListOptions(cmd: Command): Command {
  return cmd
    .option("--collection <address>", "Collection address")
    .option("--token-id <tokenId>", "Token ID")
    .option("--type <type>", "Order type: listing or offer")
    .option("--offerer <address>", "Offerer address")
    .option("--status <status>", "Order status")
    .option("--sort-by <sortBy>", "Sort mode")
    .option("--limit <number>", "Limit")
    .option("--offset <number>", "Offset");
}

function addBestOrderOptions(cmd: Command): Command {
  return cmd
    .requiredOption("--collection <address>", "Collection address")
    .option("--token-id <tokenId>", "Token ID");
}

export function registerOrdersCommands(program: Command): void {
  const ordersCommand = program.command("orders").description("Read and interact with order book data");

  addListOptions(
    ordersCommand
      .command("list")
      .description("List orders with optional filters"),
  ).action(async function (this: Command) {
    await runOrdersList(this, "orders list");
  });

  // Root alias
  addListOptions(
    program
      .command("list")
      .description("Alias for orders list"),
  ).action(async function (this: Command) {
    await runOrdersList(this, "list");
  });

  ordersCommand
    .command("get <orderHash>")
    .description("Get a single order by hash")
    .action(async function (this: Command, orderHash: string) {
      await runOrderGet(this, "orders get", orderHash);
    });

  program
    .command("get <orderHash>")
    .description("Alias for orders get")
    .action(async function (this: Command, orderHash: string) {
      await runOrderGet(this, "get", orderHash);
    });

  addBestOrderOptions(
    ordersCommand
      .command("best-listing")
      .description("Get the best active listing for a collection or token"),
  ).action(async function (this: Command) {
    await runBestOrder(this, "orders best-listing", "listing");
  });

  addBestOrderOptions(
    program
      .command("best-listing")
      .description("Alias for orders best-listing"),
  ).action(async function (this: Command) {
    await runBestOrder(this, "best-listing", "listing");
  });

  addBestOrderOptions(
    ordersCommand
      .command("best-offer")
      .description("Get the best active offer for a collection or token"),
  ).action(async function (this: Command) {
    await runBestOrder(this, "orders best-offer", "offer");
  });

  addBestOrderOptions(
    program
      .command("best-offer")
      .description("Alias for orders best-offer"),
  ).action(async function (this: Command) {
    await runBestOrder(this, "best-offer", "offer");
  });

  // New: fill-tx command
  ordersCommand
    .command("fill-tx <orderHash>")
    .description("Build ready-to-sign fill calldata for a specific order")
    .requiredOption("--buyer <address>", "Buyer wallet address (who will send the tx)")
    .option("--validate", "Verify on-chain NFT ownership before returning calldata")
    .option("--tip-recipient <address>", "Optional tip recipient address")
    .option("--tip-bps <number>", "Optional tip in basis points (1-10000)")
    .action(async function (this: Command, orderHash: string) {
      await runFillTx(this, "orders fill-tx", orderHash);
    });

  program
    .command("fill-tx <orderHash>")
    .description("Alias for orders fill-tx")
    .requiredOption("--buyer <address>", "Buyer wallet address (who will send the tx)")
    .option("--validate", "Verify on-chain NFT ownership before returning calldata")
    .option("--tip-recipient <address>", "Optional tip recipient address")
    .option("--tip-bps <number>", "Optional tip in basis points (1-10000)")
    .action(async function (this: Command, orderHash: string) {
      await runFillTx(this, "fill-tx", orderHash);
    });

  // New: floor-tx command (best-listing + fill-tx in one call)
  addBestOrderOptions(
    ordersCommand
      .command("floor-tx")
      .description("Get floor listing and build fill calldata in one call")
      .requiredOption("--buyer <address>", "Buyer wallet address (who will send the tx)")
      .option("--tip-recipient <address>", "Optional tip recipient address")
      .option("--tip-bps <number>", "Optional tip in basis points (1-10000)"),
  ).action(async function (this: Command) {
    await runFloorTx(this, "orders floor-tx");
  });

  addBestOrderOptions(
    program
      .command("floor-tx")
      .description("Alias for orders floor-tx")
      .requiredOption("--buyer <address>", "Buyer wallet address (who will send the tx)")
      .option("--tip-recipient <address>", "Optional tip recipient address")
      .option("--tip-bps <number>", "Optional tip in basis points (1-10000)"),
  ).action(async function (this: Command) {
    await runFloorTx(this, "floor-tx");
  });
}
