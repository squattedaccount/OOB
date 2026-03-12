import { Command } from "commander";
import { getLocalOptions } from "../config.js";
import { CliError } from "../errors.js";
import { formatKeyValueBlock } from "../output/index.js";
import { withConfig } from "../runtime.js";
import { createWalletContext } from "../wallet.js";

// ─── Option Interfaces ──────────────────────────────────────────────────────

interface CreateListingOptions {
  collection: string;
  tokenId: string;
  price: string;
  currency?: string;
  duration?: string;
  tokenStandard?: string;
  quantity?: string;
  royaltyBps?: string;
  royaltyRecipient?: string;
}

interface CreateOfferOptions {
  collection: string;
  tokenId?: string;
  amount: string;
  currency: string;
  duration?: string;
  tokenStandard?: string;
  quantity?: string;
  royaltyBps?: string;
  royaltyRecipient?: string;
}

interface FillOptions {
  tipRecipient?: string;
  tipBps?: string;
}

interface SweepOptions {
  collection: string;
  count: string;
  maxPrice?: string;
  currency?: string;
  tipRecipient?: string;
  tipBps?: string;
}

interface AcceptOfferOptions {
  tokenId?: string;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function parsePriceToWei(price: string): string {
  // If it contains a decimal point, treat as ETH and convert to wei
  if (price.includes(".")) {
    const parts = price.split(".");
    const whole = parts[0] || "0";
    const frac = (parts[1] || "").padEnd(18, "0").slice(0, 18);
    const wei = BigInt(whole) * 10n ** 18n + BigInt(frac);
    return wei.toString();
  }
  // Otherwise treat as raw wei
  return price;
}

function formatTxResult(result: Record<string, unknown>): string[] {
  const entries: Array<[string, unknown]> = [];
  for (const [key, value] of Object.entries(result)) {
    if (value !== undefined && value !== null) {
      entries.push([key, value]);
    }
  }
  return formatKeyValueBlock(entries);
}

// ─── create-listing ─────────────────────────────────────────────────────────

async function runCreateListing(command: Command, commandName: string): Promise<void> {
  await withConfig(command, commandName, async (config) => {
    const options = getLocalOptions<CreateListingOptions>(command);
    const priceWei = parsePriceToWei(options.price);
    const { formatEther } = await import("viem");

    if (config.dryRun) {
      return {
        dryRun: true,
        action: "create-listing",
        collection: options.collection,
        tokenId: options.tokenId,
        priceWei,
        priceEth: formatEther(BigInt(priceWei)),
        currency: options.currency || "0x0000000000000000000000000000000000000000",
        chainId: config.chainId,
        message: "Would sign and submit listing order. Use without --dry-run to execute.",
      };
    }

    const ctx = await createWalletContext(config);
    const result = await ctx.oob.createListing({
      collection: options.collection,
      tokenId: options.tokenId,
      priceWei,
      currency: options.currency,
      duration: options.duration ? Number(options.duration) : undefined,
      tokenStandard: (options.tokenStandard as "ERC721" | "ERC1155") || undefined,
      quantity: options.quantity || undefined,
      royaltyBps: options.royaltyBps ? Number(options.royaltyBps) : undefined,
      royaltyRecipient: options.royaltyRecipient,
    });

    process.stderr.write(`[oob] listing submitted: ${result.orderHash}\n`);

    return {
      orderHash: result.orderHash,
      status: result.status,
      collection: options.collection,
      tokenId: options.tokenId,
      priceWei,
      priceEth: formatEther(BigInt(priceWei)),
      seller: ctx.address,
      chainId: config.chainId,
    };
  }, formatTxResult);
}

// ─── create-offer ───────────────────────────────────────────────────────────

async function runCreateOffer(command: Command, commandName: string): Promise<void> {
  await withConfig(command, commandName, async (config) => {
    const options = getLocalOptions<CreateOfferOptions>(command);
    const amountWei = parsePriceToWei(options.amount);
    const { formatEther } = await import("viem");

    if (config.dryRun) {
      return {
        dryRun: true,
        action: "create-offer",
        collection: options.collection,
        tokenId: options.tokenId || "(collection offer)",
        amountWei,
        amountEth: formatEther(BigInt(amountWei)),
        currency: options.currency,
        chainId: config.chainId,
        message: "Would sign and submit offer order. Use without --dry-run to execute.",
      };
    }

    const ctx = await createWalletContext(config);
    const result = await ctx.oob.createOffer({
      collection: options.collection,
      tokenId: options.tokenId,
      amountWei,
      currency: options.currency,
      duration: options.duration ? Number(options.duration) : undefined,
      tokenStandard: (options.tokenStandard as "ERC721" | "ERC1155") || undefined,
      quantity: options.quantity || undefined,
      royaltyBps: options.royaltyBps ? Number(options.royaltyBps) : undefined,
      royaltyRecipient: options.royaltyRecipient,
    });

    process.stderr.write(`[oob] offer submitted: ${result.orderHash}\n`);

    return {
      orderHash: result.orderHash,
      status: result.status,
      collection: options.collection,
      tokenId: options.tokenId || "(collection offer)",
      amountWei,
      amountEth: formatEther(BigInt(amountWei)),
      offerer: ctx.address,
      chainId: config.chainId,
    };
  }, formatTxResult);
}

// ─── fill ───────────────────────────────────────────────────────────────────

async function runFill(command: Command, commandName: string, orderHash: string): Promise<void> {
  await withConfig(command, commandName, async (config) => {
    const options = getLocalOptions<FillOptions>(command);
    const { formatEther } = await import("viem");

    // Fetch order info first for dry-run display
    if (config.dryRun) {
      const { createClient } = await import("../client.js");
      const client = createClient(config);
      const orderResp = await client.getOrder(orderHash);
      const order = orderResp.order;
      return {
        dryRun: true,
        action: "fill",
        orderHash,
        orderType: order?.orderType || "unknown",
        priceWei: order?.priceWei || "unknown",
        priceEth: order?.priceWei ? formatEther(BigInt(order.priceWei)) : "unknown",
        chainId: config.chainId,
        ...(options.tipRecipient ? { tipRecipient: options.tipRecipient, tipBps: options.tipBps } : {}),
        message: "Would fill order on-chain. Use without --dry-run to execute.",
      };
    }

    const ctx = await createWalletContext(config);
    const tipParams = options.tipRecipient && options.tipBps
      ? { tip: { recipient: options.tipRecipient, basisPoints: Number(options.tipBps) } }
      : undefined;

    const txHash = await ctx.oob.fillOrder(orderHash, tipParams);
    process.stderr.write(`[oob] fill tx sent: ${txHash}\n`);

    return {
      txHash,
      orderHash,
      filler: ctx.address,
      chainId: config.chainId,
      ...(options.tipRecipient ? { tipRecipient: options.tipRecipient, tipBps: options.tipBps } : {}),
    };
  }, formatTxResult);
}

// ─── cancel ─────────────────────────────────────────────────────────────────

async function runCancel(command: Command, commandName: string, orderHash: string): Promise<void> {
  await withConfig(command, commandName, async (config) => {
    if (config.dryRun) {
      return {
        dryRun: true,
        action: "cancel",
        orderHash,
        chainId: config.chainId,
        message: "Would cancel order (API + on-chain). Use without --dry-run to execute.",
      };
    }

    const ctx = await createWalletContext(config);
    const result = await ctx.oob.cancelOrder(orderHash);
    process.stderr.write(`[oob] cancel tx sent: ${result.txHash}\n`);

    return {
      txHash: result.txHash,
      apiStatus: result.apiStatus,
      orderHash,
      chainId: config.chainId,
    };
  }, formatTxResult);
}

// ─── sweep ──────────────────────────────────────────────────────────────────

async function runSweep(command: Command, commandName: string): Promise<void> {
  await withConfig(command, commandName, async (config) => {
    const options = getLocalOptions<SweepOptions>(command);
    const count = Number(options.count);
    if (!Number.isInteger(count) || count < 1 || count > 50) {
      throw new CliError("INVALID_INPUT", 3, "Sweep count must be an integer between 1 and 50");
    }

    const maxPriceWei = options.maxPrice ? parsePriceToWei(options.maxPrice) : undefined;

    // Fetch cheapest active listings
    const { createClient } = await import("../client.js");
    const client = createClient(config);
    const { orders } = await client.getOrders({
      collection: options.collection,
      type: "listing",
      status: "active",
      sortBy: "price_asc",
      limit: count,
    });

    if (orders.length === 0) {
      throw new CliError("API_ERROR", 1, `No active listings found for collection ${options.collection}`);
    }

    // Filter by max price if specified
    const eligible = maxPriceWei
      ? orders.filter((o) => BigInt(o.priceWei) <= BigInt(maxPriceWei))
      : orders;

    if (eligible.length === 0) {
      throw new CliError("API_ERROR", 1, `No listings found below max price ${maxPriceWei}`);
    }

    const totalCostWei = eligible.reduce((sum, o) => sum + BigInt(o.priceWei), 0n);
    const { formatEther } = await import("viem");

    if (config.dryRun) {
      return {
        dryRun: true,
        action: "sweep",
        collection: options.collection,
        count: eligible.length,
        totalCostWei: totalCostWei.toString(),
        totalCostEth: formatEther(totalCostWei),
        orders: eligible.map((o) => ({
          orderHash: o.orderHash,
          tokenId: o.tokenId,
          priceWei: o.priceWei,
          priceEth: formatEther(BigInt(o.priceWei)),
        })),
        chainId: config.chainId,
        message: `Would fill ${eligible.length} orders. Use without --dry-run to execute.`,
      };
    }

    const ctx = await createWalletContext(config);
    const tipParams = options.tipRecipient && options.tipBps
      ? { tip: { recipient: options.tipRecipient, basisPoints: Number(options.tipBps) } }
      : undefined;

    const results: Array<{ orderHash: string; txHash?: string; error?: string }> = [];

    for (const order of eligible) {
      try {
        const txHash = await ctx.oob.fillOrder(order.orderHash, tipParams);
        process.stderr.write(`[oob] sweep fill tx sent: ${txHash} (${order.orderHash})\n`);
        results.push({ orderHash: order.orderHash, txHash });
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[oob] sweep fill failed: ${order.orderHash}: ${errMsg}\n`);
        results.push({ orderHash: order.orderHash, error: errMsg });
      }
    }

    const filled = results.filter((r) => r.txHash).length;
    const failed = results.filter((r) => r.error).length;

    return {
      collection: options.collection,
      attempted: results.length,
      filled,
      failed,
      totalCostWei: totalCostWei.toString(),
      totalCostEth: formatEther(totalCostWei),
      results,
      chainId: config.chainId,
    };
  }, formatTxResult);
}

// ─── accept-offer ───────────────────────────────────────────────────────────

async function runAcceptOffer(command: Command, commandName: string, orderHash: string): Promise<void> {
  await withConfig(command, commandName, async (config) => {
    const options = getLocalOptions<AcceptOfferOptions>(command);
    const { formatEther } = await import("viem");

    if (config.dryRun) {
      const { createClient } = await import("../client.js");
      const client = createClient(config);
      const orderResp = await client.getOrder(orderHash);
      const order = orderResp.order;
      return {
        dryRun: true,
        action: "accept-offer",
        orderHash,
        orderType: order?.orderType || "unknown",
        priceWei: order?.priceWei || "unknown",
        priceEth: order?.priceWei ? formatEther(BigInt(order.priceWei)) : "unknown",
        chainId: config.chainId,
        message: "Would accept offer on-chain. Use without --dry-run to execute.",
      };
    }

    const ctx = await createWalletContext(config);
    const txHash = await ctx.oob.acceptOpenOffer(orderHash, {
      tokenId: options.tokenId,
    });
    process.stderr.write(`[oob] accept-offer tx sent: ${txHash}\n`);

    return {
      txHash,
      orderHash,
      seller: ctx.address,
      chainId: config.chainId,
    };
  }, formatTxResult);
}

// ─── Registration ───────────────────────────────────────────────────────────

export function registerWriteOrderCommands(ordersCommand: Command, program: Command): void {
  // create-listing
  const createListingOpts = (cmd: Command): Command =>
    cmd
      .requiredOption("--collection <address>", "NFT collection contract address")
      .requiredOption("--token-id <id>", "Token ID to list")
      .requiredOption("--price <amount>", "Price in ETH (e.g. 1.5) or wei")
      .option("--currency <address>", "Payment currency (default: native ETH)")
      .option("--duration <seconds>", "Listing duration in seconds (default: 30 days)")
      .option("--token-standard <standard>", "Token standard: ERC721 or ERC1155")
      .option("--quantity <n>", "Quantity for ERC1155 listings")
      .option("--royalty-bps <n>", "Royalty basis points")
      .option("--royalty-recipient <address>", "Royalty recipient address");

  createListingOpts(
    ordersCommand
      .command("create-listing")
      .description("Create and submit a listing order (sell an NFT)"),
  ).action(async function (this: Command) {
    await runCreateListing(this, "orders create-listing");
  });

  createListingOpts(
    program
      .command("create-listing")
      .description("Alias for orders create-listing"),
  ).action(async function (this: Command) {
    await runCreateListing(this, "create-listing");
  });

  // create-offer
  const createOfferOpts = (cmd: Command): Command =>
    cmd
      .requiredOption("--collection <address>", "NFT collection contract address")
      .requiredOption("--amount <amount>", "Offer amount in ETH (e.g. 0.5) or wei")
      .requiredOption("--currency <address>", "Payment currency (e.g. WETH address)")
      .option("--token-id <id>", "Token ID for token-specific offer (omit for collection offer)")
      .option("--duration <seconds>", "Offer duration in seconds (default: 24 hours)")
      .option("--token-standard <standard>", "Token standard: ERC721 or ERC1155")
      .option("--quantity <n>", "Quantity for ERC1155 offers")
      .option("--royalty-bps <n>", "Royalty basis points")
      .option("--royalty-recipient <address>", "Royalty recipient address");

  createOfferOpts(
    ordersCommand
      .command("create-offer")
      .description("Create and submit an offer order (bid on an NFT or collection)"),
  ).action(async function (this: Command) {
    await runCreateOffer(this, "orders create-offer");
  });

  createOfferOpts(
    program
      .command("create-offer")
      .description("Alias for orders create-offer"),
  ).action(async function (this: Command) {
    await runCreateOffer(this, "create-offer");
  });

  // fill
  const fillOpts = (cmd: Command): Command =>
    cmd
      .option("--tip-recipient <address>", "Optional tip recipient address")
      .option("--tip-bps <number>", "Optional tip in basis points (1-10000)");

  fillOpts(
    ordersCommand
      .command("fill <orderHash>")
      .description("Fill (buy/accept) an order on-chain"),
  ).action(async function (this: Command, orderHash: string) {
    await runFill(this, "orders fill", orderHash);
  });

  fillOpts(
    program
      .command("fill <orderHash>")
      .description("Alias for orders fill"),
  ).action(async function (this: Command, orderHash: string) {
    await runFill(this, "fill", orderHash);
  });

  // cancel
  ordersCommand
    .command("cancel <orderHash>")
    .description("Cancel an order (API + on-chain)")
    .action(async function (this: Command, orderHash: string) {
      await runCancel(this, "orders cancel", orderHash);
    });

  program
    .command("cancel <orderHash>")
    .description("Alias for orders cancel")
    .action(async function (this: Command, orderHash: string) {
      await runCancel(this, "cancel", orderHash);
    });

  // sweep
  const sweepOpts = (cmd: Command): Command =>
    cmd
      .requiredOption("--collection <address>", "NFT collection to sweep")
      .requiredOption("--count <n>", "Number of cheapest listings to fill (max 50)")
      .option("--max-price <amount>", "Maximum price per item in ETH or wei")
      .option("--tip-recipient <address>", "Optional tip recipient address")
      .option("--tip-bps <number>", "Optional tip in basis points (1-10000)");

  sweepOpts(
    ordersCommand
      .command("sweep")
      .description("Sweep floor — fill multiple cheapest listings"),
  ).action(async function (this: Command) {
    await runSweep(this, "orders sweep");
  });

  sweepOpts(
    program
      .command("sweep")
      .description("Alias for orders sweep"),
  ).action(async function (this: Command) {
    await runSweep(this, "sweep");
  });

  // accept-offer
  const acceptOfferOpts = (cmd: Command): Command =>
    cmd
      .option("--token-id <id>", "Token ID to use when accepting a collection offer");

  acceptOfferOpts(
    ordersCommand
      .command("accept-offer <orderHash>")
      .description("Accept an open collection offer on-chain"),
  ).action(async function (this: Command, orderHash: string) {
    await runAcceptOffer(this, "orders accept-offer", orderHash);
  });

  acceptOfferOpts(
    program
      .command("accept-offer <orderHash>")
      .description("Alias for orders accept-offer"),
  ).action(async function (this: Command, orderHash: string) {
    await runAcceptOffer(this, "accept-offer", orderHash);
  });
}
