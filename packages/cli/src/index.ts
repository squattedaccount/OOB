// Public API exports for programmatic use of @oob/cli
// This module re-exports all types, the client, config, output utilities,
// and the CLI program builder for use as a library.

import { Command } from "commander";
import { addGlobalOptions } from "./config.js";
import {
  registerActivityCommands,
  registerAgentCommands,
  registerAnalyzeCommands,
  registerApproveCommands,
  registerBatchCommands,
  registerCollectionsCommands,
  registerCompletionsCommands,
  registerConfigCommands,
  registerDescribeCommands,
  registerMarketCommands,
  registerOrdersCommands,
  registerSetupCommands,
  registerStreamCommands,
  registerWalletCommands,
  registerWatchCommands,
  registerWriteOrderCommands,
} from "./commands/index.js";
import { installActionCompatibility, normalizeArgvForLegacyCommander, pendingActionPromises } from "./runtime.js";

// Re-export types
export type {
  ActivityEvent,
  ActivityResponse,
  BatchRequest,
  BatchResult,
  BatchRunOptions,
  BestOrderOptions,
  CollectionStatsResponse,
  CommandOptions,
  ConfigDoctorData,
  DescribeSchema,
  FillTxResponse,
  GetBestOrderParams,
  GetOrdersParams,
  MarketSnapshotData,
  MarketTargetOptions,
  OobOrder,
  OrdersListOptions,
  OrdersResponse,
  OrderStatus,
  OrderType,
  ProtocolConfigResponse,
  RuntimeConfig,
  SingleOrderResponse,
  SortBy,
  TokenSummaryData,
} from "./types.js";

export type { OutputFormat } from "./types.js";

// Re-export client for programmatic use
export { CliApiClient, createClient } from "./client.js";

// Re-export config utilities
export { resolveConfig, addGlobalOptions } from "./config.js";

// Re-export output utilities
export { formatToon } from "./output/toon.js";
export { formatTable } from "./output/table.js";
export { renderSuccess, emitError, formatKeyValueBlock, formatValue, selectField } from "./output/index.js";

// Re-export runtime
export { withConfig } from "./runtime.js";

// Re-export errors
export { CliError, OobApiError, classifyError } from "./errors.js";
export type { CliErrorCode } from "./errors.js";

// Re-export wallet utilities (types only at top level; functions are async and lazy-load viem/@oob/sdk)
export { createWalletContext, createReadOnlyContext, requirePrivateKey, createPublicClientFromConfig } from "./wallet.js";
export type { WalletContext } from "./wallet.js";

export function buildProgram(): Command {
  installActionCompatibility();

  const program = addGlobalOptions(
    new Command()
      .name("oob")
      .description("Open Order Book CLI for agents and power users")
      .version("0.1.0"),
  );

  registerConfigCommands(program);
  registerOrdersCommands(program);
  registerCollectionsCommands(program);
  registerMarketCommands(program);
  registerActivityCommands(program);
  registerApproveCommands(program);
  registerWalletCommands(program);
  registerBatchCommands(program);
  registerDescribeCommands(program);
  registerStreamCommands(program);
  registerWatchCommands(program);
  registerAnalyzeCommands(program);
  registerAgentCommands(program);
  registerSetupCommands(program);
  registerCompletionsCommands(program);

  // Write order commands need the orders subcommand reference
  const ordersCommand = program.commands.find((c) => c.name() === "orders");
  if (ordersCommand) {
    registerWriteOrderCommands(ordersCommand, program);
  }

  return program;
}

export async function runCli(argv: string[] = process.argv): Promise<void> {
  const program = buildProgram();
  await program.parseAsync(normalizeArgvForLegacyCommander(argv));
  if (pendingActionPromises.size > 0) {
    await Promise.allSettled(Array.from(pendingActionPromises));
  }
}
