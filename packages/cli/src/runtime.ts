import { setTimeout as delay } from "node:timers/promises";
import { Command } from "commander";
import type { CliApiClient } from "./client.js";
import { createClient } from "./client.js";
import { resolveConfig } from "./config.js";
import { renderSuccess, emitError } from "./output/index.js";
import type { RuntimeConfig } from "./types.js";

export const pendingActionPromises = new Set<Promise<unknown>>();

type ActionHandler = (this: Command, ...args: any[]) => void | Promise<void>;

let actionCompatibilityInstalled = false;

function trackActionPromise(result: unknown): void {
  if (!result || typeof result !== "object" || !("then" in result)) {
    return;
  }

  const promise = result as Promise<unknown>;
  pendingActionPromises.add(promise);
  void promise.finally(() => {
    pendingActionPromises.delete(promise);
  });
}

export function installActionCompatibility(): void {
  if (actionCompatibilityInstalled) {
    return;
  }

  const originalAction = Command.prototype.action;

  Command.prototype.action = function patchedAction(fn: ActionHandler) {
    return originalAction.call(this, function wrappedAction(this: Command, ...args: any[]): void | Promise<void> {
      const result = fn.apply(this, args);
      trackActionPromise(result);
      return result;
    });
  };

  actionCompatibilityInstalled = true;
}

export async function withConfig<T>(
  command: Command,
  commandName: string,
  action: (config: RuntimeConfig, client: CliApiClient) => Promise<T>,
  text: (result: T) => string[],
): Promise<void> {
  let config: RuntimeConfig | undefined;
  try {
    config = resolveConfig(command);
    const client = createClient(config);
    const runOnce = async (): Promise<void> => {
      const result = await action(config as RuntimeConfig, client);
      renderSuccess(commandName, config as RuntimeConfig, result, text(result));
    };

    if (config.watch) {
      while (true) {
        await runOnce();
        await delay(config.intervalMs);
      }
    } else {
      await runOnce();
    }
  } catch (error) {
    emitError(commandName, config, error);
  }
}

export function normalizeArgvForLegacyCommander(argv: string[]): string[] {
  if (argv.length < 4) {
    return argv;
  }

  const normalized = [...argv];
  const optionNamesWithValues = new Set([
    "--chain-id",
    "--api-url",
    "--api-key",
    "--env",
    "--output",
    "--field",
    "--interval",
    "--timeout",
    "--retries",
    "--retry-delay",
    "--max-lines",
    "--private-key",
    "--rpc-url",
  ]);

  let commandIndex = 2;
  while (commandIndex < normalized.length) {
    const token = normalized[commandIndex];
    if (!token.startsWith("-")) {
      break;
    }
    if (optionNamesWithValues.has(token)) {
      commandIndex += 2;
    } else {
      commandIndex += 1;
    }
  }

  const first = normalized[commandIndex];
  const second = normalized[commandIndex + 1];

  if (!first || !second) {
    return normalized;
  }

  if (first === "config" && (second === "show" || second === "check" || second === "doctor" || second === "protocol")) {
    normalized.splice(commandIndex, 2, `config-${second}`);
    return normalized;
  }

  if (first === "orders" && (second === "list" || second === "get" || second === "best-listing" || second === "best-offer" || second === "fill-tx" || second === "floor-tx" || second === "create-listing" || second === "create-offer" || second === "fill" || second === "cancel" || second === "sweep" || second === "accept-offer")) {
    normalized.splice(commandIndex, 2, second);
    return normalized;
  }

  if (first === "collections" && second === "stats") {
    normalized.splice(commandIndex, 2, "stats");
    return normalized;
  }

  if (first === "market" && (second === "snapshot" || second === "token-summary")) {
    normalized.splice(commandIndex, 2, second);
    return normalized;
  }

  if (first === "batch" && (second === "run" || second === "execute")) {
    normalized.splice(commandIndex, 2, `batch-${second}`);
    return normalized;
  }

  if (first === "activity" && (second === "list" || second === "order")) {
    normalized.splice(commandIndex, 2, `activity-${second}`);
    return normalized;
  }

  if (first === "wallet" && (second === "info" || second === "balance" || second === "check-approval" || second === "approve-nft" || second === "approve-erc20")) {
    normalized.splice(commandIndex, 2, `wallet-${second}`);
    return normalized;
  }

  if (first === "watch" && (second === "order" || second === "price" || second === "collection")) {
    normalized.splice(commandIndex, 2, `watch-${second}`);
    return normalized;
  }

  if (first === "analyze" && (second === "depth" || second === "spread" || second === "price-history" || second === "portfolio")) {
    normalized.splice(commandIndex, 2, `analyze-${second}`);
    return normalized;
  }

  if (first === "agent" && second === "manifest") {
    normalized.splice(commandIndex, 2, "agent-manifest");
    return normalized;
  }

  if (first === "mcp" && second === "serve") {
    normalized.splice(commandIndex, 2, "mcp-serve");
    return normalized;
  }

  return normalized;
}
