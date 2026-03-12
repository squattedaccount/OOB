import { Command } from "commander";
import { withConfig } from "../runtime.js";
import type { DescribeSchema } from "../types.js";

// Machine-readable command schemas for AI agents.
// Each schema describes a command's inputs and outputs so agents can
// discover capabilities programmatically without parsing help text.

const COMMAND_SCHEMAS: Record<string, DescribeSchema> = {
  "orders-list": {
    name: "orders list",
    description: "List orders with optional filters",
    arguments: [],
    options: [
      { name: "collection", flags: "--collection <address>", description: "Collection address", required: false },
      { name: "tokenId", flags: "--token-id <tokenId>", description: "Token ID", required: false },
      { name: "type", flags: "--type <type>", description: "Order type: listing or offer", required: false },
      { name: "offerer", flags: "--offerer <address>", description: "Offerer address", required: false },
      { name: "status", flags: "--status <status>", description: "Order status: active, filled, cancelled, expired, stale", required: false },
      { name: "sortBy", flags: "--sort-by <sortBy>", description: "Sort: created_at_desc, price_asc, price_desc", required: false },
      { name: "limit", flags: "--limit <number>", description: "Max results (1-100)", required: false },
      { name: "offset", flags: "--offset <number>", description: "Pagination offset", required: false },
    ],
    outputFields: ["orders[]", "orders[].orderHash", "orders[].orderType", "orders[].priceWei", "orders[].status", "orders[].nftContract", "orders[].tokenId", "total"],
  },
  "orders-get": {
    name: "orders get",
    description: "Get a single order by hash",
    arguments: [
      { name: "orderHash", description: "The order hash to look up", required: true, type: "string" },
    ],
    options: [],
    outputFields: ["order.orderHash", "order.orderType", "order.priceWei", "order.status", "order.nftContract", "order.tokenId", "order.offerer", "order.signature", "order.orderJson"],
  },
  "orders-best-listing": {
    name: "orders best-listing",
    description: "Get the cheapest active listing for a collection or token",
    arguments: [],
    options: [
      { name: "collection", flags: "--collection <address>", description: "Collection address", required: true },
      { name: "tokenId", flags: "--token-id <tokenId>", description: "Token ID (omit for collection floor)", required: false },
    ],
    outputFields: ["order.orderHash", "order.priceWei", "order.nftContract", "order.tokenId"],
  },
  "orders-best-offer": {
    name: "orders best-offer",
    description: "Get the highest active offer for a collection or token",
    arguments: [],
    options: [
      { name: "collection", flags: "--collection <address>", description: "Collection address", required: true },
      { name: "tokenId", flags: "--token-id <tokenId>", description: "Token ID (omit for collection-wide)", required: false },
    ],
    outputFields: ["order.orderHash", "order.priceWei", "order.nftContract", "order.tokenId"],
  },
  "orders-fill-tx": {
    name: "orders fill-tx",
    description: "Build ready-to-sign fill calldata for a specific order",
    arguments: [
      { name: "orderHash", description: "The order hash to build fill tx for", required: true, type: "string" },
    ],
    options: [
      { name: "buyer", flags: "--buyer <address>", description: "Buyer wallet address (who will send the tx)", required: true },
      { name: "validate", flags: "--validate", description: "Verify on-chain NFT ownership before returning calldata", required: false },
      { name: "tipRecipient", flags: "--tip-recipient <address>", description: "Optional tip recipient address", required: false },
      { name: "tipBps", flags: "--tip-bps <number>", description: "Optional tip in basis points (1-10000)", required: false },
    ],
    outputFields: ["to", "data", "value", "chainId", "orderHash", "nftContract", "tokenId", "priceWei", "priceDecimal", "currencySymbol", "expiresAt", "warning"],
  },
  "orders-floor-tx": {
    name: "orders floor-tx",
    description: "Get floor listing and build fill calldata in one call",
    arguments: [],
    options: [
      { name: "collection", flags: "--collection <address>", description: "Collection address", required: true },
      { name: "tokenId", flags: "--token-id <tokenId>", description: "Token ID (omit for collection floor)", required: false },
      { name: "buyer", flags: "--buyer <address>", description: "Buyer wallet address (who will send the tx)", required: true },
      { name: "tipRecipient", flags: "--tip-recipient <address>", description: "Optional tip recipient address", required: false },
      { name: "tipBps", flags: "--tip-bps <number>", description: "Optional tip in basis points (1-10000)", required: false },
    ],
    outputFields: ["to", "data", "value", "chainId", "orderHash", "nftContract", "tokenId", "priceWei", "priceDecimal", "currencySymbol", "expiresAt", "warning"],
  },
  "collections-stats": {
    name: "collections stats",
    description: "Get aggregate statistics for a collection",
    arguments: [
      { name: "collection", description: "NFT contract address", required: true, type: "string" },
    ],
    options: [],
    outputFields: ["collection", "chainId", "listingCount", "floorPriceWei", "offerCount", "bestOfferWei"],
  },
  "market-snapshot": {
    name: "market snapshot",
    description: "Get a collection-level market snapshot with spread",
    arguments: [],
    options: [
      { name: "collection", flags: "--collection <address>", description: "Collection address", required: true },
    ],
    outputFields: ["collection", "listingCount", "offerCount", "floorPriceWei", "bestListingWei", "bestOfferWei", "spreadWei"],
  },
  "market-token-summary": {
    name: "market token-summary",
    description: "Get a token-level market summary",
    arguments: [],
    options: [
      { name: "collection", flags: "--collection <address>", description: "Collection address", required: true },
      { name: "tokenId", flags: "--token-id <tokenId>", description: "Token ID", required: true },
    ],
    outputFields: ["collection", "tokenId", "totalOrders", "offerCount", "bestListingWei", "bestOfferWei"],
  },
  "activity-list": {
    name: "activity list",
    description: "List activity events with optional filters",
    arguments: [],
    options: [
      { name: "collection", flags: "--collection <address>", description: "Filter by collection address", required: false },
      { name: "tokenId", flags: "--token-id <tokenId>", description: "Filter by token ID", required: false },
      { name: "eventType", flags: "--event-type <type>", description: "Filter: listed, offer_placed, filled, cancelled, expired, stale", required: false },
      { name: "address", flags: "--address <address>", description: "Filter by from or to address", required: false },
      { name: "orderHash", flags: "--order-hash <hash>", description: "Filter by order hash", required: false },
      { name: "limit", flags: "--limit <number>", description: "Max results (1-200, default 50)", required: false },
      { name: "offset", flags: "--offset <number>", description: "Pagination offset", required: false },
    ],
    outputFields: ["activity[]", "activity[].eventType", "activity[].orderHash", "activity[].priceWei", "activity[].priceDecimal", "activity[].currencySymbol", "activity[].txHash", "activity[].createdAt", "total"],
  },
  "activity-order": {
    name: "activity order",
    description: "Get activity events for a specific order",
    arguments: [
      { name: "orderHash", description: "The order hash", required: true, type: "string" },
    ],
    options: [],
    outputFields: ["activity[]", "activity[].eventType", "activity[].orderHash", "activity[].priceWei", "activity[].priceDecimal", "activity[].currencySymbol", "activity[].txHash", "activity[].createdAt", "total"],
  },
  "config-show": {
    name: "config show",
    description: "Show resolved configuration",
    arguments: [],
    options: [],
    outputFields: ["apiUrl", "chainId", "env", "output", "apiKeyConfigured"],
  },
  "config-check": {
    name: "config check",
    description: "Verify API connectivity and return protocol config",
    arguments: [],
    options: [],
    outputFields: ["reachable", "protocolConfig.protocolFeeBps", "protocolConfig.protocolFeeRecipient"],
  },
  "config-protocol": {
    name: "config protocol",
    description: "Show protocol fee configuration from the API",
    arguments: [],
    options: [],
    outputFields: ["protocolFeeBps", "protocolFeeRecipient"],
  },
  "approve-tx": {
    name: "approve-tx",
    description: "Build ERC20 approval calldata for Seaport spending",
    arguments: [
      { name: "tokenAddress", description: "ERC20 token address to approve", required: true, type: "string" },
    ],
    options: [],
    outputFields: ["to", "data", "value"],
  },
  // ─── Phase 2: Wallet commands ──────────────────────────────────────────────
  "wallet-info": {
    name: "wallet info",
    description: "Show wallet address, ETH balance, and chain info (requires --private-key or OOB_PRIVATE_KEY)",
    arguments: [],
    options: [],
    outputFields: ["address", "chainId", "balance", "balanceEth", "rpcUrl"],
  },
  "wallet-balance": {
    name: "wallet balance",
    description: "Show ETH balance and optional ERC20 token balance",
    arguments: [],
    options: [
      { name: "token", flags: "--token <address>", description: "ERC20 token contract address to check balance for", required: false },
    ],
    outputFields: ["address", "chainId", "ethBalance", "ethBalanceFormatted", "token", "tokenSymbol", "tokenBalance", "tokenBalanceFormatted"],
  },
  "wallet-check-approval": {
    name: "wallet check-approval",
    description: "Check if an NFT collection is approved for Seaport trading",
    arguments: [],
    options: [
      { name: "collection", flags: "--collection <address>", description: "NFT collection address", required: true },
    ],
    outputFields: ["collection", "owner", "approvedForSeaport"],
  },
  "wallet-approve-nft": {
    name: "wallet approve-nft",
    description: "Approve NFT collection for Seaport trading (on-chain tx)",
    arguments: [],
    options: [
      { name: "collection", flags: "--collection <address>", description: "NFT collection address", required: true },
    ],
    outputFields: ["txHash", "collection", "chainId", "owner"],
  },
  "wallet-approve-erc20": {
    name: "wallet approve-erc20",
    description: "Approve ERC20 token for Seaport trading (on-chain tx)",
    arguments: [],
    options: [
      { name: "token", flags: "--token <address>", description: "ERC20 token contract address", required: true },
      { name: "amount", flags: "--amount <wei>", description: "Approval amount in wei (default: max uint256)", required: false },
    ],
    outputFields: ["txHash", "token", "amount", "chainId", "owner"],
  },
  // ─── Phase 2: Write order commands ─────────────────────────────────────────
  "orders-create-listing": {
    name: "orders create-listing",
    description: "Create and submit a listing order (sell an NFT). Signs off-chain and submits to API.",
    arguments: [],
    options: [
      { name: "collection", flags: "--collection <address>", description: "NFT collection contract address", required: true },
      { name: "tokenId", flags: "--token-id <id>", description: "Token ID to list", required: true },
      { name: "price", flags: "--price <amount>", description: "Price in ETH (e.g. 1.5) or wei", required: true },
      { name: "currency", flags: "--currency <address>", description: "Payment currency (default: native ETH)", required: false },
      { name: "duration", flags: "--duration <seconds>", description: "Listing duration in seconds (default: 30 days)", required: false },
      { name: "tokenStandard", flags: "--token-standard <standard>", description: "ERC721 or ERC1155", required: false },
      { name: "quantity", flags: "--quantity <n>", description: "Quantity for ERC1155", required: false },
      { name: "royaltyBps", flags: "--royalty-bps <n>", description: "Royalty basis points", required: false },
      { name: "royaltyRecipient", flags: "--royalty-recipient <address>", description: "Royalty recipient", required: false },
    ],
    outputFields: ["orderHash", "status", "collection", "tokenId", "priceWei", "priceEth", "seller", "chainId"],
  },
  "orders-create-offer": {
    name: "orders create-offer",
    description: "Create and submit an offer order (bid on an NFT or collection). Signs off-chain and submits to API.",
    arguments: [],
    options: [
      { name: "collection", flags: "--collection <address>", description: "NFT collection contract address", required: true },
      { name: "amount", flags: "--amount <amount>", description: "Offer amount in ETH or wei", required: true },
      { name: "currency", flags: "--currency <address>", description: "Payment currency (e.g. WETH address)", required: true },
      { name: "tokenId", flags: "--token-id <id>", description: "Token ID (omit for collection offer)", required: false },
      { name: "duration", flags: "--duration <seconds>", description: "Offer duration in seconds (default: 7 days)", required: false },
      { name: "tokenStandard", flags: "--token-standard <standard>", description: "ERC721 or ERC1155", required: false },
      { name: "quantity", flags: "--quantity <n>", description: "Quantity for ERC1155", required: false },
      { name: "royaltyBps", flags: "--royalty-bps <n>", description: "Royalty basis points", required: false },
      { name: "royaltyRecipient", flags: "--royalty-recipient <address>", description: "Royalty recipient", required: false },
    ],
    outputFields: ["orderHash", "status", "collection", "tokenId", "amountWei", "amountEth", "offerer", "chainId"],
  },
  "orders-fill": {
    name: "orders fill",
    description: "Fill (buy/accept) an order on-chain. Sends a transaction via connected wallet.",
    arguments: [
      { name: "orderHash", description: "The order hash to fill", required: true, type: "string" },
    ],
    options: [
      { name: "tipRecipient", flags: "--tip-recipient <address>", description: "Optional tip recipient address", required: false },
      { name: "tipBps", flags: "--tip-bps <number>", description: "Optional tip in basis points (1-10000)", required: false },
    ],
    outputFields: ["txHash", "orderHash", "filler", "chainId"],
  },
  "orders-cancel": {
    name: "orders cancel",
    description: "Cancel an order (API off-chain + Seaport on-chain cancel)",
    arguments: [
      { name: "orderHash", description: "The order hash to cancel", required: true, type: "string" },
    ],
    options: [],
    outputFields: ["txHash", "apiStatus", "orderHash", "chainId"],
  },
  "orders-sweep": {
    name: "orders sweep",
    description: "Sweep floor — fill multiple cheapest listings for a collection",
    arguments: [],
    options: [
      { name: "collection", flags: "--collection <address>", description: "NFT collection to sweep", required: true },
      { name: "count", flags: "--count <n>", description: "Number of cheapest listings to fill (max 50)", required: true },
      { name: "maxPrice", flags: "--max-price <amount>", description: "Maximum price per item in ETH or wei", required: false },
      { name: "tipRecipient", flags: "--tip-recipient <address>", description: "Optional tip recipient address", required: false },
      { name: "tipBps", flags: "--tip-bps <number>", description: "Optional tip in basis points", required: false },
    ],
    outputFields: ["collection", "attempted", "filled", "failed", "totalCostWei", "totalCostEth", "results[]", "chainId"],
  },
  "orders-accept-offer": {
    name: "orders accept-offer",
    description: "Accept an open collection offer on-chain",
    arguments: [
      { name: "orderHash", description: "The offer order hash to accept", required: true, type: "string" },
    ],
    options: [
      { name: "tokenId", flags: "--token-id <id>", description: "Token ID to use when accepting a collection offer", required: false },
    ],
    outputFields: ["txHash", "orderHash", "seller", "chainId"],
  },
  "batch-execute": {
    name: "batch execute",
    description: "Execute batch write operations from JSON/JSONL input (requires wallet). Supported: orders.create-listing, orders.create-offer, orders.fill, orders.cancel, wallet.approve-nft, wallet.approve-erc20",
    arguments: [],
    options: [
      { name: "file", flags: "--file <path>", description: "Read batch requests from a file", required: false },
      { name: "stdin", flags: "--stdin", description: "Read batch requests from stdin", required: false },
    ],
    outputFields: ["results[]", "results[].command", "results[].ok", "results[].data", "results[].error"],
  },

  // ─── Phase 3: Streaming & Monitoring ─────────────────────────────────────
  "stream": {
    name: "stream",
    description: "Connect to real-time WebSocket stream and output order events as JSONL",
    arguments: [],
    options: [
      { name: "collection", flags: "--collection <address>", description: "Filter by collection address", required: false },
      { name: "collections", flags: "--collections <addresses>", description: "Filter by comma-separated collection addresses", required: false },
      { name: "events", flags: "--events <types>", description: "Filter event types (e.g. new_listing,sale,cancellation)", required: false },
      { name: "chainIds", flags: "--chain-ids <ids>", description: "Filter by comma-separated chain IDs", required: false },
      { name: "reconnect", flags: "--no-reconnect", description: "Disable automatic reconnection", required: false },
    ],
    outputFields: ["type", "order", "order.orderHash", "order.nftContract", "order.tokenId", "order.priceWei", "timestamp"],
  },
  "watch-order": {
    name: "watch order",
    description: "Poll an order until it reaches a terminal state (filled, cancelled, expired)",
    arguments: [
      { name: "orderHash", description: "The order hash to watch", required: true, type: "string" },
    ],
    options: [],
    outputFields: ["orderHash", "status", "orderType", "collection", "tokenId", "priceWei", "iteration", "terminal", "filledTxHash", "cancelledTxHash"],
  },
  "watch-price": {
    name: "watch price",
    description: "Watch collection floor price and alert when threshold is crossed",
    arguments: [],
    options: [
      { name: "collection", flags: "--collection <address>", description: "Collection address to watch", required: true },
      { name: "below", flags: "--below <amount>", description: "Alert when floor price drops below this value (ETH or wei)", required: false },
      { name: "above", flags: "--above <amount>", description: "Alert when floor price rises above this value (ETH or wei)", required: false },
    ],
    outputFields: ["collection", "floorPriceWei", "listingCount", "offerCount", "iteration", "triggered", "alert"],
  },
  "watch-collection": {
    name: "watch collection",
    description: "Watch for new activity events on a collection",
    arguments: [],
    options: [
      { name: "collection", flags: "--collection <address>", description: "Collection address to watch", required: true },
      { name: "events", flags: "--events <types>", description: "Filter event types (comma-separated)", required: false },
    ],
    outputFields: ["collection", "newEvents", "iteration", "events[]", "events[].eventType", "events[].orderHash", "events[].priceWei"],
  },

  // ─── Phase 4: Intelligence ───────────────────────────────────────────────
  "analyze-depth": {
    name: "analyze depth",
    description: "Show order book depth (bid/ask price distribution) for a collection",
    arguments: [],
    options: [
      { name: "collection", flags: "--collection <address>", description: "Collection address", required: true },
      { name: "buckets", flags: "--buckets <n>", description: "Number of price buckets (default: 10)", required: false },
    ],
    outputFields: ["collection", "totalListings", "totalOffers", "listingDepth[]", "offerDepth[]", "listingDepth[].minWei", "listingDepth[].maxWei", "listingDepth[].count"],
  },
  "analyze-spread": {
    name: "analyze spread",
    description: "Show bid-ask spread and liquidity metrics for a collection",
    arguments: [],
    options: [
      { name: "collection", flags: "--collection <address>", description: "Collection address", required: true },
      { name: "tokenId", flags: "--token-id <id>", description: "Specific token ID", required: false },
    ],
    outputFields: ["collection", "bestListingWei", "bestOfferWei", "spreadWei", "spreadBps", "listingCount", "offerCount"],
  },
  "analyze-price-history": {
    name: "analyze price-history",
    description: "Analyze price trends from recent sales for a collection",
    arguments: [],
    options: [
      { name: "collection", flags: "--collection <address>", description: "Collection address", required: true },
      { name: "days", flags: "--days <n>", description: "Number of days to analyze (default: 7)", required: false },
      { name: "tokenId", flags: "--token-id <id>", description: "Specific token ID", required: false },
    ],
    outputFields: ["collection", "period", "sales", "minPriceWei", "maxPriceWei", "avgPriceWei", "priceChangeWei", "priceChangeBps"],
  },
  "analyze-portfolio": {
    name: "analyze portfolio",
    description: "Show active orders and positions for a wallet address",
    arguments: [
      { name: "address", description: "Wallet address to analyze", required: true, type: "string" },
    ],
    options: [],
    outputFields: ["address", "totalActiveListings", "totalActiveOffers", "collections[]", "collections[].collection", "collections[].activeListings", "collections[].activeOffers"],
  },
  "agent-manifest": {
    name: "agent manifest",
    description: "Output full capability manifest for agent frameworks (MCP, LangChain, etc.)",
    arguments: [],
    options: [],
    outputFields: ["name", "version", "description", "capabilities.read[]", "capabilities.write[]", "capabilities.monitoring[]", "capabilities.analysis[]", "outputFormats[]", "globalFlags[]"],
  },
  "mcp-serve": {
    name: "mcp serve",
    description: "Start MCP (Model Context Protocol) server over stdio for direct LLM tool use",
    arguments: [],
    options: [],
    outputFields: [],
  },

  // ─── Phase 5: Human UX ──────────────────────────────────────────────────
  "setup": {
    name: "setup",
    description: "Interactive first-time configuration wizard",
    arguments: [],
    options: [],
    outputFields: ["apiUrl", "chainId", "apiKeyConfigured", "rpcUrl", "output", "saved"],
  },
  "completions": {
    name: "completions",
    description: "Generate shell completion script for bash, zsh, or fish",
    arguments: [
      { name: "shell", description: "Shell type: bash, zsh, or fish", required: true, type: "string" },
    ],
    options: [],
    outputFields: [],
  },
};

function formatDescribeText(result: DescribeSchema): string[] {
  const lines: string[] = [
    `command: ${result.name}`,
    `description: ${result.description}`,
  ];
  if (result.arguments.length > 0) {
    lines.push("arguments:");
    for (const arg of result.arguments) {
      lines.push(`  ${arg.name} (${arg.type}, ${arg.required ? "required" : "optional"}): ${arg.description}`);
    }
  }
  if (result.options.length > 0) {
    lines.push("options:");
    for (const opt of result.options) {
      lines.push(`  ${opt.flags} (${opt.required ? "required" : "optional"}): ${opt.description}`);
    }
  }
  lines.push("outputFields:");
  for (const field of result.outputFields) {
    lines.push(`  ${field}`);
  }
  return lines;
}

function formatDescribeAllText(result: { commands: DescribeSchema[] }): string[] {
  const lines: string[] = [`total: ${result.commands.length}`, ""];
  for (const schema of result.commands) {
    lines.push(`${schema.name}: ${schema.description}`);
  }
  return lines;
}

export function registerDescribeCommands(program: Command): void {
  program
    .command("describe [command]")
    .description("Show machine-readable command schema for AI agent discovery")
    .action(async function (this: Command, commandArg?: string) {
      if (!commandArg) {
        // List all available command schemas
        await withConfig(this, "describe", async () => ({
          commands: Object.values(COMMAND_SCHEMAS),
        }), formatDescribeAllText);
        return;
      }

      const key = commandArg.replace(/\s+/g, "-").replace(/\./g, "-");
      const schema = COMMAND_SCHEMAS[key];
      if (!schema) {
        const available = Object.keys(COMMAND_SCHEMAS).join(", ");
        await withConfig(this, "describe", async () => {
          throw new Error(`Unknown command "${commandArg}". Available: ${available}`);
        }, () => []);
        return;
      }

      await withConfig(this, "describe", async () => schema, formatDescribeText);
    });
}
