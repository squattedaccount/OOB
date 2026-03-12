import { Command } from "commander";
import { CliError } from "./errors.js";
import type { CommandOptions, OutputFormat, RuntimeConfig } from "./types.js";

export const DEFAULT_API_URL = "https://api.openorderbook.xyz";
export const DEFAULT_CHAIN_ID = 8453;
export const DEFAULT_ENV = "production";
export const DEFAULT_OUTPUT: OutputFormat = "json";
export const DEFAULT_INTERVAL_MS = 10_000;
export const DEFAULT_TIMEOUT_MS = 8_000;
export const DEFAULT_RETRIES = 1;
export const DEFAULT_RETRY_DELAY_MS = 500;

export function parseNumber(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    throw new CliError("INVALID_INPUT", 3, `Invalid ${label}: expected an integer, received ${value}`);
  }
  return parsed;
}

export function parseInterval(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new CliError("INVALID_INPUT", 3, `Invalid interval: expected a positive number of seconds, received ${value}`);
  }
  return Math.round(parsed * 1000);
}

export function parsePositiveInteger(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 0) {
    throw new CliError("INVALID_INPUT", 3, `Invalid ${label}: expected a non-negative integer, received ${value}`);
  }
  return parsed;
}

export function parseTimeout(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new CliError("INVALID_INPUT", 3, `Invalid timeout: expected a positive number of milliseconds, received ${value}`);
  }
  return Math.round(parsed);
}

export function parseOutput(value: string): OutputFormat {
  if (value === "json" || value === "jsonl" || value === "text" || value === "toon" || value === "table") {
    return value;
  }
  throw new CliError("INVALID_INPUT", 3, `Invalid output format: expected json, jsonl, text, toon, or table, received ${value}`);
}

export function coerceString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function coerceBoolean(value: unknown): boolean {
  return value === true;
}

export function getEnv(name: string): string | undefined {
  return coerceString(process.env[name]);
}

export function getCommandOptions(command: Command): CommandOptions {
  let current: Command | null = command;
  const merged: CommandOptions = {};

  while (current) {
    const options = current.opts() as CommandOptions;
    for (const [key, value] of Object.entries(options)) {
      if (merged[key as keyof CommandOptions] === undefined) {
        merged[key as keyof CommandOptions] = value;
      }
    }
    current = current.parent ?? null;
  }

  return merged;
}

export function getLocalOptions<T>(command: Command): T {
  return command.opts() as T;
}

export function resolveConfig(command: Command): RuntimeConfig {
  const options = getCommandOptions(command);
  const chainIdRaw = coerceString(options.chainId) ?? getEnv("OOB_CHAIN_ID");
  const retriesRaw = coerceString(options.retries) ?? getEnv("OOB_RETRIES");
  const retryDelayRaw = coerceString(options.retryDelay) ?? getEnv("OOB_RETRY_DELAY_MS");
  const timeoutRaw = coerceString(options.timeout) ?? getEnv("OOB_TIMEOUT_MS");
  const explicitJson = coerceBoolean(options.json);
  const explicitJsonl = coerceBoolean(options.jsonl);
  const explicitText = coerceBoolean(options.text);
  const explicitToon = coerceBoolean(options.toon);
  const explicitTable = coerceBoolean(options.table);
  const outputRaw = explicitJson
    ? "json"
    : explicitJsonl
      ? "jsonl"
      : explicitText
        ? "text"
        : explicitToon
          ? "toon"
          : explicitTable
            ? "table"
            : coerceString(options.output) ?? getEnv("OOB_OUTPUT");
  const intervalRaw = coerceString(options.interval);
  const maxLinesRaw = coerceString(options.maxLines);

  return {
    apiKey: coerceString(options.apiKey) ?? getEnv("OOB_API_KEY"),
    apiUrl: coerceString(options.apiUrl) ?? getEnv("OOB_API_URL") ?? DEFAULT_API_URL,
    chainId: chainIdRaw ? parseNumber(chainIdRaw, "chainId") : DEFAULT_CHAIN_ID,
    dryRun: coerceBoolean(options.dryRun),
    env: coerceString(options.env) ?? getEnv("OOB_ENV") ?? DEFAULT_ENV,
    field: coerceString(options.field),
    humanPrices: coerceBoolean(options.humanPrices),
    intervalMs: intervalRaw ? parseInterval(intervalRaw) : DEFAULT_INTERVAL_MS,
    maxLines: maxLinesRaw ? parsePositiveInteger(maxLinesRaw, "maxLines") : undefined,
    output: outputRaw ? parseOutput(outputRaw) : DEFAULT_OUTPUT,
    privateKey: coerceString(options.privateKey) ?? getEnv("OOB_PRIVATE_KEY"),
    raw: coerceBoolean(options.raw),
    retries: retriesRaw ? parsePositiveInteger(retriesRaw, "retries") : DEFAULT_RETRIES,
    retryDelayMs: retryDelayRaw ? parsePositiveInteger(retryDelayRaw, "retryDelay") : DEFAULT_RETRY_DELAY_MS,
    rpcUrl: coerceString(options.rpcUrl) ?? getEnv("OOB_RPC_URL"),
    timeoutMs: timeoutRaw ? parseTimeout(timeoutRaw) : DEFAULT_TIMEOUT_MS,
    verbose: coerceBoolean(options.verbose),
    watch: coerceBoolean(options.watch),
    yes: coerceBoolean(options.yes),
  };
}

export function addGlobalOptions(program: Command): Command {
  return program
    .option("--chain-id <number>", "Chain ID override")
    .option("--api-url <url>", "API base URL override")
    .option("--api-key <key>", "API key override")
    .option("--env <name>", "Environment label for the current run")
    .option("--output <format>", "Output format: json, jsonl, text, or toon")
    .option("--field <path>", "Return only a nested field from the success payload, e.g. data.order.orderHash")
    .option("--raw", "Print the selected value without JSON wrapper formatting")
    .option("--watch", "Repeat the command on an interval until interrupted")
    .option("--interval <seconds>", "Polling interval in seconds when --watch is enabled")
    .option("--timeout <milliseconds>", "Abort network requests after the given timeout in milliseconds")
    .option("--retries <count>", "Retry retryable network/API failures this many times")
    .option("--retry-delay <milliseconds>", "Base delay between retries in milliseconds")
    .option("--verbose", "Log request and response details to stderr")
    .option("--max-lines <number>", "Truncate output after N lines")
    .option("--json", "Force JSON output")
    .option("--jsonl", "Force JSONL output")
    .option("--text", "Force text output")
    .option("--toon", "Force TOON output (compact, LLM-friendly)")
    .option("--table", "Force table output (human-friendly columns)")
    .option("--human-prices", "Show prices in ETH instead of wei")
    .option("--yes", "Skip confirmation prompts for write operations")
    .option("--private-key <key>", "Wallet private key for write operations (prefer OOB_PRIVATE_KEY env var)")
    .option("--rpc-url <url>", "RPC endpoint URL (prefer OOB_RPC_URL env var)")
    .option("--dry-run", "Preview write operations without executing on-chain");
}
