import { CliError } from "./errors.js";
import { coerceString, parseNumber } from "./config.js";
import type { GetBestOrderParams, GetOrdersParams, OrderStatus, OrderType, SortBy } from "./types.js";

export function normalizeAddress(value: unknown, label: string): string {
  const parsed = coerceString(value);
  if (!parsed) {
    throw new CliError("INVALID_INPUT", 3, `Missing ${label}`);
  }
  return parsed;
}

export function normalizeOptionalString(value: unknown): string | undefined {
  return coerceString(value);
}

export function normalizeRequiredString(value: unknown, label: string): string {
  const parsed = coerceString(value);
  if (!parsed) {
    throw new CliError("INVALID_INPUT", 3, `Missing ${label}`);
  }
  return parsed;
}

export function normalizeOrdersParams(args?: Record<string, unknown>): GetOrdersParams {
  return {
    collection: normalizeOptionalString(args?.collection),
    tokenId: normalizeOptionalString(args?.tokenId),
    type: normalizeOptionalString(args?.type) as OrderType | undefined,
    offerer: normalizeOptionalString(args?.offerer),
    status: normalizeOptionalString(args?.status) as OrderStatus | undefined,
    sortBy: normalizeOptionalString(args?.sortBy) as SortBy | undefined,
    limit: normalizeOptionalString(args?.limit) ? parseNumber(String(args?.limit), "limit") : undefined,
    offset: normalizeOptionalString(args?.offset) ? parseNumber(String(args?.offset), "offset") : undefined,
  };
}

export function normalizeBestOrderParams(args?: Record<string, unknown>): GetBestOrderParams {
  return {
    collection: normalizeAddress(args?.collection, "collection"),
    tokenId: normalizeOptionalString(args?.tokenId),
  };
}
