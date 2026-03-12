/**
 * Stream command — connects to the OOB WebSocket API and outputs events as JSONL.
 *
 * Usage:
 *   oob stream --collection 0x... --events new_listing,sale
 *   oob stream --chain-ids 1,8453
 */
import { Command } from "commander";
import { resolveConfig } from "../config.js";
import { CliError, classifyError } from "../errors.js";
import { emitError } from "../output/index.js";
import type { RuntimeConfig } from "../types.js";

interface StreamOptions {
  collection?: string;
  events?: string;
  chainIds?: string;
  collections?: string;
  reconnect?: boolean;
}

function buildWsUrl(config: RuntimeConfig, options: StreamOptions): string {
  const base = config.apiUrl.replace(/^http/, "ws").replace(/\/$/, "");
  const params = new URLSearchParams();
  params.set("chainId", String(config.chainId));

  if (options.collection) {
    params.set("collections", options.collection.toLowerCase());
  }
  if (options.collections) {
    params.set("collections", options.collections.toLowerCase());
  }
  if (options.events) {
    params.set("events", options.events);
  }
  if (options.chainIds) {
    params.set("chainIds", options.chainIds);
  }

  return `${base}/v1/stream?${params.toString()}`;
}

function formatStreamEvent(data: unknown, config: RuntimeConfig): string {
  if (config.output === "toon" || config.output === "text") {
    const event = data as Record<string, unknown>;
    const order = event.order as Record<string, unknown> | undefined;
    const parts = [
      event.type,
      order?.nftContract ? `${(order.nftContract as string).slice(0, 10)}...` : "",
      order?.tokenId ?? "",
      order?.priceWei ? `${order.priceWei} wei` : "",
    ].filter(Boolean);
    return parts.join(" | ");
  }
  return JSON.stringify(data);
}

async function connectAndStream(config: RuntimeConfig, options: StreamOptions): Promise<void> {
  const url = buildWsUrl(config, options);
  const shouldReconnect = options.reconnect !== false;
  let reconnectDelay = 1000;
  const maxReconnectDelay = 30000;
  let running = true;

  process.on("SIGINT", () => {
    running = false;
    process.stderr.write("\n[oob] stream interrupted\n");
    process.exit(0);
  });

  while (running) {
    try {
      if (config.verbose) {
        process.stderr.write(`[verbose] connecting to ${url}\n`);
      }

      // Dynamic import ws — use native WebSocket if available (Node 22+), fallback to ws
      let WS: typeof WebSocket;
      if (typeof globalThis.WebSocket !== "undefined") {
        WS = globalThis.WebSocket;
      } else {
        const wsModule = await import("ws");
        WS = wsModule.default as unknown as typeof WebSocket;
      }

      await new Promise<void>((resolve, reject) => {
        const ws = new WS(url);

        ws.onopen = () => {
          reconnectDelay = 1000;
          process.stderr.write(`[oob] stream connected to ${config.apiUrl}\n`);
        };

        ws.onmessage = (event: MessageEvent) => {
          try {
            const data = JSON.parse(typeof event.data === "string" ? event.data : String(event.data));
            if (data.type === "pong" || data.type === "subscribed") {
              if (config.verbose) {
                process.stderr.write(`[verbose] ${JSON.stringify(data)}\n`);
              }
              return;
            }
            process.stdout.write(`${formatStreamEvent(data, config)}\n`);
          } catch {
            process.stdout.write(`${String(event.data)}\n`);
          }
        };

        ws.onerror = (err: Event) => {
          if (config.verbose) {
            process.stderr.write(`[verbose] ws error: ${String(err)}\n`);
          }
          reject(new Error("WebSocket error"));
        };

        ws.onclose = () => {
          process.stderr.write("[oob] stream disconnected\n");
          resolve();
        };

        // Keep-alive ping every 30s
        const pingInterval = setInterval(() => {
          try {
            if (ws.readyState === ws.OPEN) {
              ws.send(JSON.stringify({ type: "ping" }));
            }
          } catch { /* ignore */ }
        }, 30000);

        // Clean up on process exit
        const cleanup = () => {
          clearInterval(pingInterval);
          try { ws.close(); } catch { /* ignore */ }
        };
        process.on("SIGINT", cleanup);
        process.on("SIGTERM", cleanup);
      });

      if (!shouldReconnect || !running) break;
    } catch (error) {
      if (!shouldReconnect || !running) {
        throw error;
      }
      process.stderr.write(`[oob] reconnecting in ${reconnectDelay / 1000}s...\n`);
      await new Promise((r) => setTimeout(r, reconnectDelay));
      reconnectDelay = Math.min(reconnectDelay * 2, maxReconnectDelay);
    }
  }
}

export function registerStreamCommands(program: Command): void {
  program
    .command("stream")
    .description("Connect to real-time WebSocket stream and output events as JSONL")
    .option("--collection <address>", "Filter by collection address")
    .option("--collections <addresses>", "Filter by comma-separated collection addresses")
    .option("--events <types>", "Filter event types (e.g. new_listing,sale,cancellation)")
    .option("--chain-ids <ids>", "Filter by comma-separated chain IDs")
    .option("--no-reconnect", "Disable automatic reconnection")
    .action(async function (this: Command) {
      let config: RuntimeConfig | undefined;
      try {
        config = resolveConfig(this);
        const options = this.opts() as StreamOptions;
        await connectAndStream(config, options);
      } catch (error) {
        emitError("stream", config, error);
      }
    });
}
