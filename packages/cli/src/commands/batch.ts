import { readFile } from "node:fs/promises";
import { Command } from "commander";
import type { CliApiClient } from "../client.js";
import { getLocalOptions } from "../config.js";
import { CliError, classifyError } from "../errors.js";
import { withConfig } from "../runtime.js";
import type { BatchRequest, BatchResult, BatchRunOptions, RuntimeConfig } from "../types.js";
import { normalizeAddress, normalizeBestOrderParams, normalizeOrdersParams, normalizeRequiredString } from "../utils.js";
import { getMarketSnapshotData, getTokenSummaryData } from "./market.js";
import { coerceString } from "../config.js";
import { createWalletContext, type WalletContext } from "../wallet.js";

function assertBatchRequest(value: unknown): BatchRequest {
  if (!value || typeof value !== "object") {
    throw new CliError("BATCH_INPUT_ERROR", 3, "Each batch item must be an object");
  }

  const command = coerceString((value as Record<string, unknown>).command);
  const args = (value as Record<string, unknown>).args;

  if (!command) {
    throw new CliError("BATCH_INPUT_ERROR", 3, "Each batch item must include a command");
  }

  if (args !== undefined && (typeof args !== "object" || args === null || Array.isArray(args))) {
    throw new CliError("BATCH_INPUT_ERROR", 3, `Invalid args for batch command ${command}`);
  }

  return {
    command,
    args: args as Record<string, unknown> | undefined,
  };
}

async function readInputFile(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    const classified = error instanceof Error ? error.message : "Unable to read input file";
    throw new CliError("BATCH_INPUT_ERROR", 3, classified);
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];

  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }

  return Buffer.concat(chunks).toString("utf8");
}

function parseBatchRequests(input: string): BatchRequest[] {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new CliError("BATCH_INPUT_ERROR", 3, "Batch input is empty");
  }

  try {
    if (trimmed.startsWith("[")) {
      const parsed = JSON.parse(trimmed) as unknown;
      if (!Array.isArray(parsed)) {
        throw new CliError("BATCH_INPUT_ERROR", 3, "Batch input array is invalid");
      }
      return parsed.map(assertBatchRequest);
    }

    return trimmed
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0)
      .map((line) => assertBatchRequest(JSON.parse(line) as unknown));
  } catch (error) {
    if (error instanceof CliError) {
      throw error;
    }
    throw new CliError("BATCH_INPUT_ERROR", 3, error instanceof Error ? error.message : "Invalid batch JSON input");
  }
}

function getBatchExitCode(results: BatchResult[]): number {
  const exitCodes = results
    .map((result) => result.error?.exitCode)
    .filter((value): value is number => typeof value === "number");

  if (exitCodes.includes(3)) {
    return 3;
  }
  if (exitCodes.includes(4)) {
    return 4;
  }
  if (exitCodes.includes(2)) {
    return 2;
  }
  if (exitCodes.includes(5)) {
    return 5;
  }
  if (exitCodes.includes(1)) {
    return 1;
  }
  return 0;
}

async function executeBatchRequest(client: CliApiClient, request: BatchRequest): Promise<BatchResult> {
  try {
    switch (request.command) {
      case "config.check": {
        const data = await client.getProtocolConfig();
        return { command: request.command, data, ok: true };
      }
      case "orders.list": {
        const data = await client.getOrders(normalizeOrdersParams(request.args));
        return { command: request.command, data, ok: true };
      }
      case "orders.get": {
        const orderHash = normalizeRequiredString(request.args?.orderHash, "orderHash");
        const data = await client.getOrder(orderHash);
        return { command: request.command, data, ok: true };
      }
      case "orders.best-listing": {
        const data = await client.getBestListing(normalizeBestOrderParams(request.args));
        return { command: request.command, data, ok: true };
      }
      case "orders.best-offer": {
        const data = await client.getBestOffer(normalizeBestOrderParams(request.args));
        return { command: request.command, data, ok: true };
      }
      case "orders.fill-tx": {
        const orderHash = normalizeRequiredString(request.args?.orderHash, "orderHash");
        const buyer = normalizeAddress(request.args?.buyer, "buyer");
        const data = await client.getFillTx(orderHash, buyer);
        return { command: request.command, data, ok: true };
      }
      case "orders.floor-tx": {
        const buyer = normalizeAddress(request.args?.buyer, "buyer");
        const params = normalizeBestOrderParams(request.args);
        const data = await client.getBestListingFillTx({ ...params, buyer });
        return { command: request.command, data, ok: true };
      }
      case "collections.stats": {
        const collection = normalizeAddress(request.args?.collection, "collection");
        const data = await client.getCollectionStats(collection);
        return { command: request.command, data, ok: true };
      }
      case "market.snapshot": {
        const collection = normalizeAddress(request.args?.collection, "collection");
        const data = await getMarketSnapshotData(client, collection);
        return { command: request.command, data, ok: true };
      }
      case "token.summary": {
        const collection = normalizeAddress(request.args?.collection, "collection");
        const tokenId = normalizeRequiredString(request.args?.tokenId, "tokenId");
        const data = await getTokenSummaryData(client, collection, tokenId);
        return { command: request.command, data, ok: true };
      }
      case "activity.order": {
        const orderHash = normalizeRequiredString(request.args?.orderHash, "orderHash");
        const data = await client.getOrderActivity(orderHash);
        return { command: request.command, data, ok: true };
      }
      default:
        throw new CliError("INVALID_INPUT", 3, `Unsupported batch command ${request.command}`);
    }
  } catch (error) {
    const classified = classifyError(error);
    return {
      command: request.command,
      error: {
        code: classified.code,
        exitCode: classified.exitCode,
        message: classified.message,
        name: classified.name,
        status: classified.status,
      },
      ok: false,
    };
  }
}

function formatBatchText(result: BatchResult[]): string[] {
  return result.map((item) => `${item.ok ? "ok" : "error"}: ${item.command}`);
}

// ─── Batch Execute (write operations) ───────────────────────────────────────

async function executeWriteRequest(ctx: WalletContext, config: RuntimeConfig, request: BatchRequest): Promise<BatchResult> {
  try {
    switch (request.command) {
      case "orders.create-listing": {
        const collection = normalizeRequiredString(request.args?.collection, "collection");
        const tokenId = normalizeRequiredString(request.args?.tokenId, "tokenId");
        const priceWei = normalizeRequiredString(request.args?.priceWei, "priceWei");
        const currency = coerceString(request.args?.currency) || undefined;
        const duration = request.args?.duration ? Number(request.args.duration) : undefined;
        const data = await ctx.oob.createListing({
          collection, tokenId, priceWei, currency, duration,
        });
        return { command: request.command, data, ok: true };
      }
      case "orders.create-offer": {
        const collection = normalizeRequiredString(request.args?.collection, "collection");
        const amountWei = normalizeRequiredString(request.args?.amountWei, "amountWei");
        const currency = normalizeRequiredString(request.args?.currency, "currency");
        const tokenId = coerceString(request.args?.tokenId) || undefined;
        const duration = request.args?.duration ? Number(request.args.duration) : undefined;
        const data = await ctx.oob.createOffer({
          collection, tokenId, amountWei, currency, duration,
        });
        return { command: request.command, data, ok: true };
      }
      case "orders.fill": {
        const orderHash = normalizeRequiredString(request.args?.orderHash, "orderHash");
        const txHash = await ctx.oob.fillOrder(orderHash);
        return { command: request.command, data: { txHash, orderHash }, ok: true };
      }
      case "orders.cancel": {
        const orderHash = normalizeRequiredString(request.args?.orderHash, "orderHash");
        const result = await ctx.oob.cancelOrder(orderHash);
        return { command: request.command, data: result, ok: true };
      }
      case "wallet.approve-nft": {
        const collection = normalizeRequiredString(request.args?.collection, "collection");
        const txHash = await ctx.oob.approveCollection(collection);
        return { command: request.command, data: { txHash, collection }, ok: true };
      }
      case "wallet.approve-erc20": {
        const token = normalizeRequiredString(request.args?.token, "token");
        const txHash = await ctx.oob.approveErc20(token);
        return { command: request.command, data: { txHash, token }, ok: true };
      }
      default:
        throw new CliError("INVALID_INPUT", 3, `Unsupported batch execute command ${request.command}`);
    }
  } catch (error) {
    const classified = classifyError(error);
    return {
      command: request.command,
      error: {
        code: classified.code,
        exitCode: classified.exitCode,
        message: classified.message,
        name: classified.name,
        status: classified.status,
      },
      ok: false,
    };
  }
}

async function runBatch(command: Command, commandName: string): Promise<void> {
  await withConfig(command, commandName, async (_config, client) => {
    const options = getLocalOptions<BatchRunOptions>(command);
    const input = options.file
      ? await readInputFile(options.file)
      : options.stdin
        ? await readStdin()
        : (() => {
            throw new CliError("BATCH_INPUT_ERROR", 3, "batch run requires --file or --stdin");
          })();
    const requests = parseBatchRequests(input);
    const results: BatchResult[] = [];
    for (const request of requests) {
      results.push(await executeBatchRequest(client, request));
    }
    const batchExitCode = getBatchExitCode(results);
    if (batchExitCode > 0) {
      process.exitCode = batchExitCode;
    }
    return results;
  }, formatBatchText);
}

async function runBatchExecute(command: Command, commandName: string): Promise<void> {
  await withConfig(command, commandName, async (config) => {
    const options = getLocalOptions<BatchRunOptions>(command);
    const input = options.file
      ? await readInputFile(options.file)
      : options.stdin
        ? await readStdin()
        : (() => {
            throw new CliError("BATCH_INPUT_ERROR", 3, "batch execute requires --file or --stdin");
          })();
    const requests = parseBatchRequests(input);

    if (config.dryRun) {
      return requests.map((r) => ({
        command: r.command,
        args: r.args,
        dryRun: true,
        ok: true,
      }));
    }

    const ctx = await createWalletContext(config);
    const results: BatchResult[] = [];
    for (const request of requests) {
      results.push(await executeWriteRequest(ctx, config, request));
    }
    const batchExitCode = getBatchExitCode(results);
    if (batchExitCode > 0) {
      process.exitCode = batchExitCode;
    }
    return results;
  }, formatBatchText);
}

export function registerBatchCommands(program: Command): void {
  const batchCommand = program.command("batch").description("Run multiple requests from JSON or JSONL input");

  batchCommand
    .command("run")
    .description("Execute batch read-only requests from --file or --stdin")
    .option("--file <path>", "Read batch requests from a file")
    .option("--stdin", "Read batch requests from stdin")
    .action(async function (this: Command) {
      await runBatch(this, "batch run");
    });

  batchCommand
    .command("execute")
    .description("Execute batch write operations from --file or --stdin (requires wallet)")
    .option("--file <path>", "Read batch requests from a file")
    .option("--stdin", "Read batch requests from stdin")
    .action(async function (this: Command) {
      await runBatchExecute(this, "batch execute");
    });

  program
    .command("batch-run")
    .description("Compatibility alias for batch run")
    .option("--file <path>", "Read batch requests from a file")
    .option("--stdin", "Read batch requests from stdin")
    .action(async function (this: Command) {
      await runBatch(this, "batch run");
    });

  program
    .command("batch-execute")
    .description("Compatibility alias for batch execute")
    .option("--file <path>", "Read batch requests from a file")
    .option("--stdin", "Read batch requests from stdin")
    .action(async function (this: Command) {
      await runBatchExecute(this, "batch execute");
    });
}
