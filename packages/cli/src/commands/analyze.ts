/**
 * Analyze commands — higher-level analytical views built from existing API data.
 *
 * Usage:
 *   oob analyze depth --collection 0x...
 *   oob analyze spread --collection 0x...
 *   oob analyze price-history --collection 0x... --days 7
 *   oob analyze portfolio <address>
 */
import { Command } from "commander";
import { getLocalOptions } from "../config.js";
import { CliError } from "../errors.js";
import { formatKeyValueBlock } from "../output/index.js";
import { withConfig } from "../runtime.js";

// ─── Analyze Depth ───────────────────────────────────────────────────────────

interface DepthOptions {
  collection: string;
  buckets?: string;
}

interface DepthBucket {
  minWei: string;
  maxWei: string;
  count: number;
  side: "listing" | "offer";
}

async function runAnalyzeDepth(command: Command, commandName: string): Promise<void> {
  await withConfig(command, commandName, async (_config, client) => {
    const options = getLocalOptions<DepthOptions>(command);
    if (!options.collection) {
      throw new CliError("INVALID_INPUT", 3, "Missing --collection");
    }

    const bucketCount = options.buckets ? Number(options.buckets) : 10;

    // Fetch listings (cheapest first) and offers (most expensive first)
    const [listings, offers] = await Promise.all([
      client.getOrders({
        collection: options.collection,
        type: "listing",
        status: "active",
        sortBy: "price_asc",
        limit: 100,
      }),
      client.getOrders({
        collection: options.collection,
        type: "offer",
        status: "active",
        sortBy: "price_desc",
        limit: 100,
      }),
    ]);

    function buildBuckets(orders: { priceWei: string }[], side: "listing" | "offer"): DepthBucket[] {
      if (orders.length === 0) return [];
      const prices = orders.map((o) => BigInt(o.priceWei));
      const min = prices.reduce((a, b) => (a < b ? a : b), prices[0]);
      const max = prices.reduce((a, b) => (a > b ? a : b), prices[0]);
      if (min === max) {
        return [{ minWei: min.toString(), maxWei: max.toString(), count: orders.length, side }];
      }
      const range = max - min;
      const step = range / BigInt(bucketCount);
      const result: DepthBucket[] = [];
      for (let i = 0; i < bucketCount; i++) {
        const lo = min + step * BigInt(i);
        const hi = i === bucketCount - 1 ? max : min + step * BigInt(i + 1) - BigInt(1);
        const count = prices.filter((p) => p >= lo && p <= hi).length;
        if (count > 0) {
          result.push({ minWei: lo.toString(), maxWei: hi.toString(), count, side });
        }
      }
      return result;
    }

    const listingBuckets = buildBuckets(listings.orders, "listing");
    const offerBuckets = buildBuckets(offers.orders, "offer");

    return {
      collection: options.collection,
      totalListings: listings.total,
      totalOffers: offers.total,
      listingDepth: listingBuckets,
      offerDepth: offerBuckets,
    };
  }, (result) => {
    const r = result as Record<string, unknown>;
    const lines = [
      `collection: ${r.collection}`,
      `listings: ${r.totalListings}  offers: ${r.totalOffers}`,
      "",
      "=== ASK (Listings) ===",
    ];
    const ld = r.listingDepth as DepthBucket[];
    for (const b of ld) {
      lines.push(`  ${b.minWei} - ${b.maxWei} wei: ${b.count} order(s)`);
    }
    lines.push("", "=== BID (Offers) ===");
    const od = r.offerDepth as DepthBucket[];
    for (const b of od) {
      lines.push(`  ${b.minWei} - ${b.maxWei} wei: ${b.count} order(s)`);
    }
    return lines;
  });
}

// ─── Analyze Spread ──────────────────────────────────────────────────────────

interface SpreadOptions {
  collection: string;
  tokenId?: string;
}

async function runAnalyzeSpread(command: Command, commandName: string): Promise<void> {
  await withConfig(command, commandName, async (config, client) => {
    const options = getLocalOptions<SpreadOptions>(command);
    if (!options.collection) {
      throw new CliError("INVALID_INPUT", 3, "Missing --collection");
    }

    const [bestListing, bestOffer, stats] = await Promise.all([
      client.getBestListing({ collection: options.collection, tokenId: options.tokenId }),
      client.getBestOffer({ collection: options.collection, tokenId: options.tokenId }),
      client.getCollectionStats(options.collection),
    ]);

    const askWei = bestListing.order?.priceWei ? BigInt(bestListing.order.priceWei) : null;
    const bidWei = bestOffer.order?.priceWei ? BigInt(bestOffer.order.priceWei) : null;

    let spreadWei: string | null = null;
    let spreadBps: number | null = null;
    if (askWei !== null && bidWei !== null && askWei > BigInt(0)) {
      spreadWei = (askWei - bidWei).toString();
      spreadBps = Number(((askWei - bidWei) * BigInt(10000)) / askWei);
    }

    return {
      collection: options.collection,
      bestListingWei: bestListing.order?.priceWei ?? null,
      bestListingHash: bestListing.order?.orderHash ?? null,
      bestOfferWei: bestOffer.order?.priceWei ?? null,
      bestOfferHash: bestOffer.order?.orderHash ?? null,
      spreadWei,
      spreadBps,
      listingCount: stats.listingCount,
      offerCount: stats.offerCount,
      floorPriceWei: stats.floorPriceWei,
    };
  }, (result) => {
    const r = result as Record<string, unknown>;
    return formatKeyValueBlock([
      ["collection", r.collection],
      ["bestListingWei", r.bestListingWei],
      ["bestOfferWei", r.bestOfferWei],
      ["spreadWei", r.spreadWei],
      ["spreadBps", r.spreadBps],
      ["listings", r.listingCount],
      ["offers", r.offerCount],
    ]);
  });
}

// ─── Analyze Price History ───────────────────────────────────────────────────

interface PriceHistoryOptions {
  collection: string;
  days?: string;
  tokenId?: string;
}

async function runAnalyzePriceHistory(command: Command, commandName: string): Promise<void> {
  await withConfig(command, commandName, async (_config, client) => {
    const options = getLocalOptions<PriceHistoryOptions>(command);
    if (!options.collection) {
      throw new CliError("INVALID_INPUT", 3, "Missing --collection");
    }

    // Fetch filled events (sales) as price history
    const result = await client.getActivity({
      collection: options.collection,
      tokenId: options.tokenId,
      eventType: "filled",
      limit: 200,
    });

    const sales = result.activity;
    if (sales.length === 0) {
      return {
        collection: options.collection,
        period: `${options.days || 7} days`,
        sales: 0,
        message: "No sales found in the requested period",
      };
    }

    const prices = sales.map((s) => BigInt(s.priceWei));
    const min = prices.reduce((a, b) => (a < b ? a : b));
    const max = prices.reduce((a, b) => (a > b ? a : b));
    const sum = prices.reduce((a, b) => a + b, BigInt(0));
    const avg = sum / BigInt(prices.length);

    // Sort by time to get trend
    const sorted = [...sales].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
    const firstPrice = BigInt(sorted[0].priceWei);
    const lastPrice = BigInt(sorted[sorted.length - 1].priceWei);
    const changeWei = lastPrice - firstPrice;
    const changeBps = firstPrice > BigInt(0) ? Number((changeWei * BigInt(10000)) / firstPrice) : 0;

    return {
      collection: options.collection,
      period: `${options.days || 7} days`,
      sales: sales.length,
      minPriceWei: min.toString(),
      maxPriceWei: max.toString(),
      avgPriceWei: avg.toString(),
      firstSalePriceWei: firstPrice.toString(),
      lastSalePriceWei: lastPrice.toString(),
      priceChangeWei: changeWei.toString(),
      priceChangeBps: changeBps,
      firstSaleAt: sorted[0].createdAt,
      lastSaleAt: sorted[sorted.length - 1].createdAt,
    };
  }, (result) => {
    const r = result as Record<string, unknown>;
    if (r.message) return [String(r.message)];
    return formatKeyValueBlock([
      ["collection", r.collection],
      ["period", r.period],
      ["sales", r.sales],
      ["minPriceWei", r.minPriceWei],
      ["maxPriceWei", r.maxPriceWei],
      ["avgPriceWei", r.avgPriceWei],
      ["priceChangeBps", r.priceChangeBps],
    ]);
  });
}

// ─── Analyze Portfolio ───────────────────────────────────────────────────────

async function runAnalyzePortfolio(command: Command, address: string, commandName: string): Promise<void> {
  await withConfig(command, commandName, async (_config, client) => {
    if (!address) {
      throw new CliError("INVALID_INPUT", 3, "Missing address argument");
    }

    // Fetch active listings and offers by this address
    const [listings, offers] = await Promise.all([
      client.getOrders({ offerer: address, type: "listing", status: "active", limit: 100 }),
      client.getOrders({ offerer: address, type: "offer", status: "active", limit: 100 }),
    ]);

    // Group by collection
    const collectionMap = new Map<string, { listings: number; offers: number; totalListingWei: bigint; totalOfferWei: bigint }>();
    for (const order of listings.orders) {
      const key = order.nftContract.toLowerCase();
      const entry = collectionMap.get(key) ?? { listings: 0, offers: 0, totalListingWei: BigInt(0), totalOfferWei: BigInt(0) };
      entry.listings++;
      entry.totalListingWei += BigInt(order.priceWei);
      collectionMap.set(key, entry);
    }
    for (const order of offers.orders) {
      const key = order.nftContract.toLowerCase();
      const entry = collectionMap.get(key) ?? { listings: 0, offers: 0, totalListingWei: BigInt(0), totalOfferWei: BigInt(0) };
      entry.offers++;
      entry.totalOfferWei += BigInt(order.priceWei);
      collectionMap.set(key, entry);
    }

    const collections = [...collectionMap.entries()].map(([collection, data]) => ({
      collection,
      activeListings: data.listings,
      activeOffers: data.offers,
      totalListingWei: data.totalListingWei.toString(),
      totalOfferWei: data.totalOfferWei.toString(),
    }));

    return {
      address,
      totalActiveListings: listings.total,
      totalActiveOffers: offers.total,
      collections,
    };
  }, (result) => {
    const r = result as Record<string, unknown>;
    const lines = [
      `address: ${r.address}`,
      `active listings: ${r.totalActiveListings}`,
      `active offers: ${r.totalActiveOffers}`,
      "",
    ];
    const cols = r.collections as { collection: string; activeListings: number; activeOffers: number }[];
    for (const c of cols) {
      lines.push(`  ${c.collection}: ${c.activeListings} listing(s), ${c.activeOffers} offer(s)`);
    }
    return lines;
  });
}

// ─── Registration ────────────────────────────────────────────────────────────

export function registerAnalyzeCommands(program: Command): void {
  const analyzeCommand = program.command("analyze").description("Market analysis and intelligence commands");

  analyzeCommand
    .command("depth")
    .description("Show order book depth (bid/ask price distribution)")
    .requiredOption("--collection <address>", "Collection address")
    .option("--buckets <n>", "Number of price buckets (default: 10)")
    .action(async function (this: Command) {
      await runAnalyzeDepth(this, "analyze depth");
    });

  analyzeCommand
    .command("spread")
    .description("Show bid-ask spread and liquidity metrics")
    .requiredOption("--collection <address>", "Collection address")
    .option("--token-id <id>", "Specific token ID")
    .action(async function (this: Command) {
      await runAnalyzeSpread(this, "analyze spread");
    });

  analyzeCommand
    .command("price-history")
    .description("Analyze price trends from recent sales")
    .requiredOption("--collection <address>", "Collection address")
    .option("--days <n>", "Number of days to analyze (default: 7)")
    .option("--token-id <id>", "Specific token ID")
    .action(async function (this: Command) {
      await runAnalyzePriceHistory(this, "analyze price-history");
    });

  analyzeCommand
    .command("portfolio <address>")
    .description("Show active orders and positions for a wallet address")
    .action(async function (this: Command, address: string) {
      await runAnalyzePortfolio(this, address, "analyze portfolio");
    });

  // Top-level aliases
  program.command("analyze-depth").description("Alias for analyze depth")
    .requiredOption("--collection <address>", "Collection address")
    .option("--buckets <n>", "Number of price buckets")
    .action(async function (this: Command) { await runAnalyzeDepth(this, "analyze depth"); });

  program.command("analyze-spread").description("Alias for analyze spread")
    .requiredOption("--collection <address>", "Collection address")
    .option("--token-id <id>", "Specific token ID")
    .action(async function (this: Command) { await runAnalyzeSpread(this, "analyze spread"); });

  program.command("analyze-price-history").description("Alias for analyze price-history")
    .requiredOption("--collection <address>", "Collection address")
    .option("--days <n>", "Number of days").option("--token-id <id>", "Token ID")
    .action(async function (this: Command) { await runAnalyzePriceHistory(this, "analyze price-history"); });

  program.command("analyze-portfolio <address>").description("Alias for analyze portfolio")
    .action(async function (this: Command, address: string) { await runAnalyzePortfolio(this, address, "analyze portfolio"); });
}
