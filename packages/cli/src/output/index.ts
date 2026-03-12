import { DEFAULT_OUTPUT } from "../config.js";
import { classifyError } from "../errors.js";
import type { RuntimeConfig } from "../types.js";
import { formatTable } from "./table.js";
import { formatToon } from "./toon.js";

export function parseFieldPath(path: string): Array<string | number> {
  return path.split(".").filter(Boolean).map((segment) => {
    if (/^\d+$/.test(segment)) {
      return Number(segment);
    }
    return segment;
  });
}

export function selectField(value: unknown, path?: string): unknown {
  if (!path) {
    return value;
  }

  let current: unknown = value;
  for (const segment of parseFieldPath(path)) {
    if (current === null || current === undefined) {
      return undefined;
    }
    if (typeof segment === "number") {
      if (!Array.isArray(current)) {
        return undefined;
      }
      current = current[segment];
      continue;
    }
    if (typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }

  return current;
}

export function toJsonLines(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => JSON.stringify(item));
  }
  return [JSON.stringify(value)];
}

export function toRawString(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") {
    return String(value);
  }
  if (value === null || value === undefined) {
    return "";
  }
  return JSON.stringify(value);
}

export function formatValue(value: unknown): string {
  if (value === null || value === undefined) {
    return "-";
  }
  if (typeof value === "object") {
    return JSON.stringify(value);
  }
  return String(value);
}

export function formatKeyValueBlock(entries: Array<[string, unknown]>): string[] {
  return entries.map(([key, value]) => `${key}: ${formatValue(value)}`);
}

function truncateLines(text: string, maxLines: number): string {
  const lines = text.split("\n");
  if (lines.length <= maxLines) {
    return text;
  }
  const truncated = lines.slice(0, maxLines);
  truncated.push(`... (${lines.length - maxLines} more lines truncated)`);
  return truncated.join("\n");
}

function applyMaxLines(output: string, config: RuntimeConfig): string {
  if (config.maxLines && config.maxLines > 0) {
    return truncateLines(output, config.maxLines);
  }
  return output;
}

function buildSuccessPayload(commandName: string, config: RuntimeConfig, data: unknown): Record<string, unknown> {
  return {
    ok: true,
    command: commandName,
    data,
    meta: {
      apiUrl: config.apiUrl,
      chainId: config.chainId,
      retries: config.retries,
      retryDelayMs: config.retryDelayMs,
      timeoutMs: config.timeoutMs,
      env: config.env,
      field: config.field ?? null,
      output: config.output,
      raw: config.raw,
      watch: config.watch,
    },
  };
}

export function renderSuccess(commandName: string, config: RuntimeConfig, data: unknown, textLines?: string[]): void {
  const payload = buildSuccessPayload(commandName, config, data);
  const selected = selectField(payload, config.field);

  if (config.raw) {
    process.stdout.write(`${applyMaxLines(toRawString(selected), config)}\n`);
    return;
  }

  if (config.output === "toon") {
    const output = formatToon(config.field ? selected : payload);
    process.stdout.write(`${applyMaxLines(output, config)}\n`);
    return;
  }

  if (config.output === "table") {
    // Table mode: render the data portion as an aligned table
    const tableData = config.field ? selected : data;
    const output = formatTable(tableData);
    process.stdout.write(`${applyMaxLines(output, config)}\n`);
    return;
  }

  if (config.output === "json") {
    const output = JSON.stringify(config.field ? selected : payload, null, 2);
    process.stdout.write(`${applyMaxLines(output, config)}\n`);
    return;
  }

  if (config.output === "jsonl") {
    const lines = toJsonLines(config.field ? selected : payload);
    process.stdout.write(`${applyMaxLines(lines.join("\n"), config)}\n`);
    return;
  }

  // text mode
  if (config.field) {
    if (Array.isArray(selected)) {
      const output = selected.map((item) => formatValue(item)).join("\n");
      process.stdout.write(`${applyMaxLines(output, config)}\n`);
      return;
    }
    if (selected !== null && typeof selected === "object") {
      const output = JSON.stringify(selected, null, 2);
      process.stdout.write(`${applyMaxLines(output, config)}\n`);
      return;
    }
    process.stdout.write(`${formatValue(selected)}\n`);
    return;
  }

  const output = (textLines ?? [JSON.stringify(data, null, 2)]).join("\n");
  process.stdout.write(`${applyMaxLines(output, config)}\n`);
}

export function emitError(commandName: string, config: RuntimeConfig | undefined, error: unknown): void {
  const classified = classifyError(error);
  const output = config?.output ?? DEFAULT_OUTPUT;
  const payload = {
    name: classified.name,
    code: classified.code,
    message: classified.message,
    status: classified.status,
  };

  if (output === "json" || output === "toon") {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      command: commandName,
      error: payload,
      meta: config
        ? {
            apiUrl: config.apiUrl,
            chainId: config.chainId,
            env: config.env,
            field: config.field ?? null,
            output: config.output,
            raw: config.raw,
            retries: config.retries,
            retryDelayMs: config.retryDelayMs,
            timeoutMs: config.timeoutMs,
            watch: config.watch,
          }
        : undefined,
    }, null, 2)}\n`);
  } else if (output === "jsonl") {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      command: commandName,
      error: payload,
    })}\n`);
  } else {
    process.stderr.write(`${payload.code} ${payload.name}: ${payload.message}\n`);
  }

  process.exitCode = classified.exitCode;
}

export { formatToon } from "./toon.js";
