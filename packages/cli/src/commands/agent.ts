/**
 * Agent commands — capability manifest and MCP server mode.
 *
 * Usage:
 *   oob agent manifest       # Output full capability manifest JSON
 *   oob mcp serve             # Start MCP server over stdio
 */
import { Command } from "commander";
import { withConfig } from "../runtime.js";
import { resolveConfig } from "../config.js";
import { createClient } from "../client.js";
import { emitError, renderSuccess } from "../output/index.js";
import type { RuntimeConfig } from "../types.js";

// ─── Agent Manifest ──────────────────────────────────────────────────────────

function buildManifest() {
  return {
    name: "oob-cli",
    version: "0.1.0",
    description: "Open Order Book CLI — agent-first toolkit for NFT marketplace operations on Seaport v1.6",
    protocol: "Seaport v1.6",
    chains: [
      { id: 1, name: "Ethereum Mainnet" },
      { id: 8453, name: "Base" },
      { id: 84532, name: "Base Sepolia" },
    ],
    capabilities: {
      read: [
        { command: "orders list", description: "List orders with filters" },
        { command: "orders get <hash>", description: "Get a single order" },
        { command: "orders best-listing", description: "Get cheapest active listing" },
        { command: "orders best-offer", description: "Get highest active offer" },
        { command: "orders fill-tx <hash>", description: "Build fill transaction calldata" },
        { command: "orders floor-tx", description: "Get floor listing + fill calldata" },
        { command: "collections stats <address>", description: "Collection aggregate stats" },
        { command: "market snapshot", description: "Market snapshot with spread" },
        { command: "market token-summary", description: "Token-level market summary" },
        { command: "activity list", description: "List activity events" },
        { command: "activity order <hash>", description: "Activity for a specific order" },
        { command: "config show", description: "Show resolved configuration" },
        { command: "config check", description: "Verify API connectivity" },
        { command: "config protocol", description: "Protocol fee configuration" },
      ],
      write: [
        { command: "orders create-listing", description: "Create and sign a listing order", requiresWallet: true },
        { command: "orders create-offer", description: "Create and sign an offer order", requiresWallet: true },
        { command: "orders fill <hash>", description: "Fill an order on-chain", requiresWallet: true },
        { command: "orders cancel <hash>", description: "Cancel an order", requiresWallet: true },
        { command: "orders sweep", description: "Sweep floor (fill multiple cheapest listings)", requiresWallet: true },
        { command: "orders accept-offer <hash>", description: "Accept a collection offer", requiresWallet: true },
        { command: "wallet approve-nft", description: "Approve NFT collection for Seaport", requiresWallet: true },
        { command: "wallet approve-erc20", description: "Approve ERC20 for Seaport", requiresWallet: true },
      ],
      monitoring: [
        { command: "stream", description: "Real-time WebSocket event stream" },
        { command: "watch order <hash>", description: "Poll order until terminal state" },
        { command: "watch price", description: "Monitor floor price thresholds" },
        { command: "watch collection", description: "Monitor collection activity" },
      ],
      analysis: [
        { command: "analyze depth", description: "Order book depth distribution" },
        { command: "analyze spread", description: "Bid-ask spread metrics" },
        { command: "analyze price-history", description: "Price trend analysis from sales" },
        { command: "analyze portfolio <addr>", description: "Active orders by wallet" },
      ],
      batch: [
        { command: "batch run", description: "Batch read operations from JSON/JSONL" },
        { command: "batch execute", description: "Batch write operations from JSON/JSONL", requiresWallet: true },
      ],
      meta: [
        { command: "describe [command]", description: "Machine-readable command schemas" },
        { command: "agent manifest", description: "This capability manifest" },
        { command: "mcp serve", description: "Start MCP server over stdio" },
      ],
    },
    outputFormats: ["json", "jsonl", "text", "toon", "table"],
    globalFlags: [
      "--chain-id", "--api-url", "--api-key", "--env", "--output", "--field", "--raw",
      "--watch", "--interval", "--timeout", "--retries", "--verbose", "--max-lines",
      "--json", "--jsonl", "--text", "--toon", "--table", "--human-prices",
      "--private-key", "--rpc-url", "--dry-run", "--yes",
    ],
    discovery: "Use 'oob describe' to list all command schemas, or 'oob describe <command>' for a specific schema.",
  };
}

async function runAgentManifest(command: Command, commandName: string): Promise<void> {
  await withConfig(command, commandName, async () => {
    return buildManifest();
  }, (result) => {
    return [JSON.stringify(result, null, 2)];
  });
}

// ─── MCP Server ──────────────────────────────────────────────────────────────

async function runMcpServe(command: Command): Promise<void> {
  let config: RuntimeConfig | undefined;
  try {
    config = resolveConfig(command);
    const client = createClient(config);

    process.stderr.write("[oob] starting MCP server over stdio...\n");

    // Dynamic import MCP SDK
    const { Server } = await import("@modelcontextprotocol/sdk/server/index.js");
    const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");

    const server = new Server(
      { name: "oob-cli", version: "0.1.0" },
      { capabilities: { tools: {} } },
    );

    // Register tools
    server.setRequestHandler(
      { method: "tools/list" } as any,
      async () => ({
        tools: [
          {
            name: "orders_list",
            description: "List orders with optional filters",
            inputSchema: {
              type: "object",
              properties: {
                collection: { type: "string", description: "Collection address" },
                tokenId: { type: "string", description: "Token ID" },
                type: { type: "string", enum: ["listing", "offer"], description: "Order type" },
                status: { type: "string", enum: ["active", "filled", "cancelled", "expired"], description: "Status" },
                sortBy: { type: "string", enum: ["created_at_desc", "price_asc", "price_desc"] },
                limit: { type: "number", description: "Max results (1-100)" },
              },
            },
          },
          {
            name: "orders_get",
            description: "Get a single order by hash",
            inputSchema: {
              type: "object",
              properties: { orderHash: { type: "string", description: "Order hash" } },
              required: ["orderHash"],
            },
          },
          {
            name: "orders_best_listing",
            description: "Get cheapest active listing for a collection",
            inputSchema: {
              type: "object",
              properties: {
                collection: { type: "string", description: "Collection address" },
                tokenId: { type: "string", description: "Token ID (optional)" },
              },
              required: ["collection"],
            },
          },
          {
            name: "orders_best_offer",
            description: "Get highest active offer for a collection",
            inputSchema: {
              type: "object",
              properties: {
                collection: { type: "string", description: "Collection address" },
                tokenId: { type: "string", description: "Token ID (optional)" },
              },
              required: ["collection"],
            },
          },
          {
            name: "orders_fill_tx",
            description: "Build ready-to-sign fill calldata for an order",
            inputSchema: {
              type: "object",
              properties: {
                orderHash: { type: "string", description: "Order hash" },
                buyer: { type: "string", description: "Buyer wallet address" },
              },
              required: ["orderHash", "buyer"],
            },
          },
          {
            name: "collections_stats",
            description: "Get aggregate statistics for a collection",
            inputSchema: {
              type: "object",
              properties: { collection: { type: "string", description: "Collection address" } },
              required: ["collection"],
            },
          },
          {
            name: "activity_list",
            description: "List activity events with filters",
            inputSchema: {
              type: "object",
              properties: {
                collection: { type: "string" },
                tokenId: { type: "string" },
                eventType: { type: "string" },
                address: { type: "string" },
                limit: { type: "number" },
              },
            },
          },
          {
            name: "market_snapshot",
            description: "Get collection market snapshot with spread",
            inputSchema: {
              type: "object",
              properties: { collection: { type: "string", description: "Collection address" } },
              required: ["collection"],
            },
          },
          {
            name: "analyze_spread",
            description: "Compute bid-ask spread for a collection",
            inputSchema: {
              type: "object",
              properties: {
                collection: { type: "string", description: "Collection address" },
                tokenId: { type: "string" },
              },
              required: ["collection"],
            },
          },
        ],
      }),
    );

    server.setRequestHandler(
      { method: "tools/call" } as any,
      async (request: any) => {
        const { name, arguments: args } = request.params;
        try {
          let result: unknown;
          switch (name) {
            case "orders_list":
              result = await client.getOrders(args ?? {});
              break;
            case "orders_get":
              result = await client.getOrder(args.orderHash);
              break;
            case "orders_best_listing":
              result = await client.getBestListing({ collection: args.collection, tokenId: args.tokenId });
              break;
            case "orders_best_offer":
              result = await client.getBestOffer({ collection: args.collection, tokenId: args.tokenId });
              break;
            case "orders_fill_tx":
              result = await client.getFillTx(args.orderHash, args.buyer);
              break;
            case "collections_stats":
              result = await client.getCollectionStats(args.collection);
              break;
            case "activity_list":
              result = await client.getActivity(args ?? {});
              break;
            case "market_snapshot": {
              const stats = await client.getCollectionStats(args.collection);
              const [bl, bo] = await Promise.all([
                client.getBestListing({ collection: args.collection }),
                client.getBestOffer({ collection: args.collection }),
              ]);
              const askWei = bl.order?.priceWei ? BigInt(bl.order.priceWei) : null;
              const bidWei = bo.order?.priceWei ? BigInt(bo.order.priceWei) : null;
              result = {
                ...stats,
                bestListingWei: bl.order?.priceWei ?? null,
                bestOfferWei: bo.order?.priceWei ?? null,
                spreadWei: askWei !== null && bidWei !== null ? (askWei - bidWei).toString() : null,
              };
              break;
            }
            case "analyze_spread": {
              const [bestL, bestO] = await Promise.all([
                client.getBestListing({ collection: args.collection, tokenId: args.tokenId }),
                client.getBestOffer({ collection: args.collection, tokenId: args.tokenId }),
              ]);
              const ask = bestL.order?.priceWei ? BigInt(bestL.order.priceWei) : null;
              const bid = bestO.order?.priceWei ? BigInt(bestO.order.priceWei) : null;
              let spreadBps: number | null = null;
              if (ask !== null && bid !== null && ask > BigInt(0)) {
                spreadBps = Number(((ask - bid) * BigInt(10000)) / ask);
              }
              result = {
                bestListingWei: bestL.order?.priceWei ?? null,
                bestOfferWei: bestO.order?.priceWei ?? null,
                spreadWei: ask !== null && bid !== null ? (ask - bid).toString() : null,
                spreadBps,
              };
              break;
            }
            default:
              return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
          }
          return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
        }
      },
    );

    const transport = new StdioServerTransport();
    await server.connect(transport);
    process.stderr.write("[oob] MCP server running on stdio\n");
  } catch (error) {
    emitError("mcp serve", config, error);
  }
}

// ─── Registration ────────────────────────────────────────────────────────────

export function registerAgentCommands(program: Command): void {
  const agentCommand = program.command("agent").description("Agent tooling and integration commands");

  agentCommand
    .command("manifest")
    .description("Output full capability manifest for agent frameworks")
    .action(async function (this: Command) {
      await runAgentManifest(this, "agent manifest");
    });

  program
    .command("agent-manifest")
    .description("Alias for agent manifest")
    .action(async function (this: Command) {
      await runAgentManifest(this, "agent manifest");
    });

  program
    .command("mcp")
    .command("serve")
    .description("Start MCP (Model Context Protocol) server over stdio")
    .action(async function (this: Command) {
      await runMcpServe(this);
    });
}
