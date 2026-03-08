import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { Command } from "commander";

export type OutputFormat = "json" | "jsonl" | "text";

type CliErrorCode =
  | "API_ERROR"
  | "AUTH_ERROR"
  | "BATCH_INPUT_ERROR"
  | "INVALID_INPUT"
  | "NETWORK_ERROR"
  | "NOT_FOUND"
  | "INTERNAL_ERROR";

interface CommandOptions {
  apiKey?: unknown;
  apiUrl?: unknown;
  chainId?: unknown;
  env?: unknown;
  field?: unknown;
  interval?: unknown;
  json?: unknown;
  jsonl?: unknown;
  output?: unknown;
  raw?: unknown;
  text?: unknown;
  watch?: unknown;
}

interface BatchRunOptions {
  file?: string;
  stdin?: boolean;
}

interface BatchRequest {
  args?: Record<string, unknown>;
  command: string;
}

interface BatchResult {
  command: string;
  data?: unknown;
  error?: {
    code: CliErrorCode;
    exitCode: number;
    message: string;
    name: string;
    status?: number;
  };
  ok: boolean;
}

interface MarketTargetOptions {
  collection: string;
  tokenId?: string;
}

interface TokenSummaryData {
  bestListing: OobOrder | null;
  bestOffer: OobOrder | null;
  collection: string;
  offerCount: number;
  tokenId: string;
  totalOrders: number;
}

interface MarketSnapshotData {
  bestListing: OobOrder | null;
  bestOffer: OobOrder | null;
  collection: string;
  floorPriceWei: string | null;
  listingCount: number;
  offerCount: number;
  spreadWei: string | null;
}

interface ConfigDoctorData {
  apiKeyConfigured: boolean;
  apiReachable: boolean;
  apiUrl: string;
  chainId: number;
  env: string;
  nodeVersion: string;
  output: OutputFormat;
}

class CliApiClient {
  constructor(private readonly config: RuntimeConfig) {}

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (this.config.apiKey) {
      headers["X-API-Key"] = this.config.apiKey;
    }

    return headers;
  }

  private baseUrl(): string {
    return this.config.apiUrl.replace(/\/$/, "");
  }

  private async get<T>(path: string): Promise<T> {
    const response = await fetch(`${this.baseUrl()}${path}`, {
      method: "GET",
      headers: this.headers(),
    });

    if (!response.ok) {
      let message = `API error ${response.status}`;
      try {
        const body = await response.json() as { error?: string };
        if (body.error) {
          message = body.error;
        }
      } catch {
        // no-op
      }
      throw new OobApiError(response.status, message);
    }

    return response.json() as Promise<T>;
  }

  async getProtocolConfig(): Promise<ProtocolConfigResponse> {
    return this.get<ProtocolConfigResponse>("/v1/config");
  }

  async getOrders(params: GetOrdersParams): Promise<OrdersResponse> {
    const qs = new URLSearchParams();
    qs.set("chainId", String(this.config.chainId));
    if (params.collection) qs.set("collection", params.collection);
    if (params.tokenId) qs.set("tokenId", params.tokenId);
    if (params.type) qs.set("type", params.type);
    if (params.offerer) qs.set("offerer", params.offerer);
    if (params.status) qs.set("status", params.status);
    if (params.sortBy) qs.set("sortBy", params.sortBy);
    if (params.limit != null) qs.set("limit", String(params.limit));
    if (params.offset != null) qs.set("offset", String(params.offset));
    return this.get<OrdersResponse>(`/v1/orders?${qs.toString()}`);
  }

  async getOrder(orderHash: string): Promise<SingleOrderResponse> {
    return this.get<SingleOrderResponse>(`/v1/orders/${orderHash}`);
  }

  async getBestListing(params: GetBestOrderParams): Promise<SingleOrderResponse> {
    const qs = new URLSearchParams();
    qs.set("chainId", String(this.config.chainId));
    qs.set("collection", params.collection);
    if (params.tokenId) qs.set("tokenId", params.tokenId);
    return this.get<SingleOrderResponse>(`/v1/orders/best-listing?${qs.toString()}`);
  }

  async getBestOffer(params: GetBestOrderParams): Promise<SingleOrderResponse> {
    const qs = new URLSearchParams();
    qs.set("chainId", String(this.config.chainId));
    qs.set("collection", params.collection);
    if (params.tokenId) qs.set("tokenId", params.tokenId);
    return this.get<SingleOrderResponse>(`/v1/orders/best-offer?${qs.toString()}`);
  }

  async getCollectionStats(collection: string): Promise<CollectionStatsResponse> {
    const qs = new URLSearchParams();
    qs.set("chainId", String(this.config.chainId));
    return this.get<CollectionStatsResponse>(`/v1/collections/${collection.toLowerCase()}/stats?${qs.toString()}`);
  }
}

interface OrdersListOptions {
  collection?: string;
  limit?: string;
  offerer?: string;
  offset?: string;
  sortBy?: string;
  status?: string;
  tokenId?: string;
  type?: string;
}

interface BestOrderOptions {
  collection: string;
  tokenId?: string;
}

interface ProtocolConfigResponse {
  protocolFeeBps: number;
  protocolFeeRecipient: string;
}

type OrderStatus = "active" | "filled" | "cancelled" | "expired" | "stale";
type OrderType = "listing" | "offer";
type SortBy = "created_at_desc" | "price_asc" | "price_desc";

interface OobOrder {
  orderHash: string;
  chainId: number;
  orderType: OrderType;
  offerer: string;
  nftContract: string;
  tokenId: string;
  tokenStandard: "ERC721" | "ERC1155";
  priceWei: string;
  currency: string;
  protocolFeeRecipient: string;
  protocolFeeBps: number;
  royaltyRecipient: string | null;
  royaltyBps: number;
  startTime: number;
  endTime: number;
  status: OrderStatus;
  createdAt: string;
  filledTxHash: string | null;
  filledAt: string | null;
  cancelledTxHash: string | null;
  cancelledAt: string | null;
  orderJson: unknown;
  signature: string;
}

interface OrdersResponse {
  orders: OobOrder[];
  total: number;
}

interface SingleOrderResponse {
  order: OobOrder | null;
}

interface CollectionStatsResponse {
  collection: string;
  chainId: number;
  listingCount: number;
  floorPriceWei: string | null;
  offerCount: number;
  bestOfferWei: string | null;
}

interface GetOrdersParams {
  collection?: string;
  tokenId?: string;
  type?: OrderType;
  offerer?: string;
  status?: OrderStatus;
  sortBy?: SortBy;
  limit?: number;
  offset?: number;
}

interface GetBestOrderParams {
  collection: string;
  tokenId?: string;
}

class OobApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "OobApiError";
  }
}

class CliError extends Error {
  constructor(
    public readonly code: CliErrorCode,
    public readonly exitCode: number,
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "CliError";
  }
}

export interface RuntimeConfig {
  apiKey?: string;
  apiUrl: string;
  chainId: number;
  env: string;
  field?: string;
  intervalMs: number;
  output: OutputFormat;
  raw: boolean;
  watch: boolean;
}

const DEFAULT_API_URL = "https://api.openorderbook.xyz";
const DEFAULT_CHAIN_ID = 8453;
const DEFAULT_ENV = "production";
const DEFAULT_OUTPUT: OutputFormat = "json";
const DEFAULT_INTERVAL_MS = 10_000;
const pendingActionPromises = new Set<Promise<unknown>>();

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

function installActionCompatibility(): void {
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

function normalizeArgvForLegacyCommander(argv: string[]): string[] {
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

  if (first === "config" && (second === "show" || second === "check" || second === "doctor")) {
    normalized.splice(commandIndex, 2, second === "show" ? "config-show" : second === "check" ? "config-check" : "config-doctor");
    return normalized;
  }

  if (first === "orders" && (second === "list" || second === "get" || second === "best-listing" || second === "best-offer")) {
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

  if (first === "batch" && second === "run") {
    normalized.splice(commandIndex, 2, "batch-run");
    return normalized;
  }

  return normalized;
}

function parseNumber(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    throw new CliError("INVALID_INPUT", 3, `Invalid ${label}: expected an integer, received ${value}`);
  }
  return parsed;
}

function parseInterval(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new CliError("INVALID_INPUT", 3, `Invalid interval: expected a positive number of seconds, received ${value}`);
  }
  return Math.round(parsed * 1000);
}

function parseOutput(value: string): OutputFormat {
  if (value === "json" || value === "jsonl" || value === "text") {
    return value;
  }
  throw new CliError("INVALID_INPUT", 3, `Invalid output format: expected json, jsonl, or text, received ${value}`);
}

function coerceString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function getEnv(name: string): string | undefined {
  return coerceString(process.env[name]);
}

function getCommandOptions(command: Command): CommandOptions {
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

function getLocalOptions<T>(command: Command): T {
  return command.opts() as T;
}

function coerceBoolean(value: unknown): boolean {
  return value === true;
}

function parseFieldPath(path: string): Array<string | number> {
  return path.split(".").filter(Boolean).map((segment) => {
    if (/^\d+$/.test(segment)) {
      return Number(segment);
    }
    return segment;
  });
}

function selectField(value: unknown, path?: string): unknown {
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

function toJsonLines(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => JSON.stringify(item));
  }
  return [JSON.stringify(value)];
}

function toRawString(value: unknown): string {
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

function buildSuccessPayload(commandName: string, config: RuntimeConfig, data: unknown): Record<string, unknown> {
  return {
    ok: true,
    command: commandName,
    data,
    meta: {
      apiUrl: config.apiUrl,
      chainId: config.chainId,
      env: config.env,
      field: config.field ?? null,
      output: config.output,
      raw: config.raw,
      watch: config.watch,
    },
  };
}

function renderSuccess(commandName: string, config: RuntimeConfig, data: unknown, textLines?: string[]): void {
  const payload = buildSuccessPayload(commandName, config, data);
  const selected = selectField(payload, config.field);

  if (config.raw) {
    process.stdout.write(`${toRawString(selected)}\n`);
    return;
  }

  if (config.output === "json") {
    jsonWrite(config.field ? selected : payload);
    return;
  }

  if (config.output === "jsonl") {
    textWrite(toJsonLines(config.field ? selected : payload));
    return;
  }

  if (config.field) {
    if (Array.isArray(selected)) {
      textWrite(selected.map((item) => formatValue(item)));
      return;
    }
    if (selected !== null && typeof selected === "object") {
      textWrite([JSON.stringify(selected, null, 2)]);
      return;
    }
    textWrite([formatValue(selected)]);
    return;
  }

  textWrite(textLines ?? [JSON.stringify(data, null, 2)]);
}

function classifyError(error: unknown): CliError {
  if (error instanceof CliError) {
    return error;
  }
  if (error instanceof OobApiError) {
    if (error.status === 401 || error.status === 403) {
      return new CliError("AUTH_ERROR", 4, error.message, error.status);
    }
    if (error.status === 404) {
      return new CliError("NOT_FOUND", 2, error.message, error.status);
    }
    return new CliError("API_ERROR", 5, error.message, error.status);
  }
  if (error instanceof TypeError && error.message.toLowerCase().includes("fetch failed")) {
    return new CliError("NETWORK_ERROR", 5, error.message);
  }
  if (error instanceof Error) {
    return new CliError("INTERNAL_ERROR", 1, error.message);
  }
  return new CliError("INTERNAL_ERROR", 1, "Unknown error");
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

function normalizeAddress(value: unknown, label: string): string {
  const parsed = coerceString(value);
  if (!parsed) {
    throw new CliError("INVALID_INPUT", 3, `Missing ${label}`);
  }
  return parsed;
}

function normalizeOptionalString(value: unknown): string | undefined {
  return coerceString(value);
}

function normalizeRequiredString(value: unknown, label: string): string {
  const parsed = coerceString(value);
  if (!parsed) {
    throw new CliError("INVALID_INPUT", 3, `Missing ${label}`);
  }
  return parsed;
}

function normalizeOrdersParams(args?: Record<string, unknown>): GetOrdersParams {
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

function normalizeBestOrderParams(args?: Record<string, unknown>): GetBestOrderParams {
  return {
    collection: normalizeAddress(args?.collection, "collection"),
    tokenId: normalizeOptionalString(args?.tokenId),
  };
}

function getSpreadWei(bestListing: OobOrder | null, bestOffer: OobOrder | null): string | null {
  if (!bestListing?.priceWei || !bestOffer?.priceWei) {
    return null;
  }

  try {
    return (BigInt(bestListing.priceWei) - BigInt(bestOffer.priceWei)).toString();
  } catch {
    return null;
  }
}

async function getMarketSnapshotData(client: CliApiClient, collection: string): Promise<MarketSnapshotData> {
  const [stats, bestListingRes, bestOfferRes] = await Promise.all([
    client.getCollectionStats(collection),
    client.getBestListing({ collection }),
    client.getBestOffer({ collection }),
  ]);

  return {
    bestListing: bestListingRes.order,
    bestOffer: bestOfferRes.order,
    collection: stats.collection,
    floorPriceWei: stats.floorPriceWei,
    listingCount: stats.listingCount,
    offerCount: stats.offerCount,
    spreadWei: getSpreadWei(bestListingRes.order, bestOfferRes.order),
  };
}

async function getTokenSummaryData(client: CliApiClient, collection: string, tokenId: string): Promise<TokenSummaryData> {
  const [bestListingRes, bestOfferRes, orders] = await Promise.all([
    client.getBestListing({ collection, tokenId }),
    client.getBestOffer({ collection, tokenId }),
    client.getOrders({ collection, tokenId, status: "active", limit: 100 }),
  ]);

  const offerCount = orders.orders.filter((order) => order.orderType === "offer").length;

  return {
    bestListing: bestListingRes.order,
    bestOffer: bestOfferRes.order,
    collection,
    offerCount,
    tokenId,
    totalOrders: orders.total,
  };
}

async function getDoctorData(config: RuntimeConfig, client: CliApiClient): Promise<ConfigDoctorData> {
  await client.getProtocolConfig();

  return {
    apiKeyConfigured: Boolean(config.apiKey),
    apiReachable: true,
    apiUrl: config.apiUrl,
    chainId: config.chainId,
    env: config.env,
    nodeVersion: process.version,
    output: config.output,
  };
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

function resolveConfig(command: Command): RuntimeConfig {
  const options = getCommandOptions(command);
  const chainIdRaw = coerceString(options.chainId) ?? getEnv("OOB_CHAIN_ID");
  const explicitJson = coerceBoolean(options.json);
  const explicitJsonl = coerceBoolean(options.jsonl);
  const explicitText = coerceBoolean(options.text);
  const outputRaw = explicitJson
    ? "json"
    : explicitJsonl
      ? "jsonl"
    : explicitText
      ? "text"
      : coerceString(options.output) ?? getEnv("OOB_OUTPUT");
  const intervalRaw = coerceString(options.interval);

  return {
    apiKey: coerceString(options.apiKey) ?? getEnv("OOB_API_KEY"),
    apiUrl: coerceString(options.apiUrl) ?? getEnv("OOB_API_URL") ?? DEFAULT_API_URL,
    chainId: chainIdRaw ? parseNumber(chainIdRaw, "chainId") : DEFAULT_CHAIN_ID,
    env: coerceString(options.env) ?? getEnv("OOB_ENV") ?? DEFAULT_ENV,
    field: coerceString(options.field),
    intervalMs: intervalRaw ? parseInterval(intervalRaw) : DEFAULT_INTERVAL_MS,
    output: outputRaw ? parseOutput(outputRaw) : DEFAULT_OUTPUT,
    raw: coerceBoolean(options.raw),
    watch: coerceBoolean(options.watch),
  };
}

function getClient(config: RuntimeConfig): CliApiClient {
  return new CliApiClient(config);
}

function jsonWrite(payload: unknown): void {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function textWrite(lines: string[]): void {
  process.stdout.write(`${lines.join("\n")}\n`);
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) {
    return "-";
  }
  if (typeof value === "object") {
    return JSON.stringify(value);
  }
  return String(value);
}

function formatKeyValueBlock(entries: Array<[string, unknown]>): string[] {
  return entries.map(([key, value]) => `${key}: ${formatValue(value)}`);
}

function formatConfigShowText(result: {
  apiKeyConfigured: boolean;
  apiUrl: string;
  chainId: number;
  env: string;
  output: OutputFormat;
}): string[] {
  return formatKeyValueBlock([
    ["apiUrl", result.apiUrl],
    ["chainId", result.chainId],
    ["env", result.env],
    ["output", result.output],
    ["apiKeyConfigured", result.apiKeyConfigured],
  ]);
}

function formatDoctorText(result: ConfigDoctorData): string[] {
  return formatKeyValueBlock([
    ["nodeVersion", result.nodeVersion],
    ["apiReachable", result.apiReachable],
    ["apiUrl", result.apiUrl],
    ["chainId", result.chainId],
    ["env", result.env],
    ["output", result.output],
    ["apiKeyConfigured", result.apiKeyConfigured],
  ]);
}

function formatConfigCheckText(result: { reachable: boolean; protocolConfig: ProtocolConfigResponse }): string[] {
  return formatKeyValueBlock([
    ["reachable", result.reachable],
    ["protocolFeeBps", result.protocolConfig.protocolFeeBps],
    ["protocolFeeRecipient", result.protocolConfig.protocolFeeRecipient],
  ]);
}

function formatOrdersListText(result: OrdersResponse): string[] {
  const lines = [`total: ${result.total}`];
  for (const order of result.orders) {
    lines.push(`${order.orderHash} ${order.orderType} ${order.priceWei} ${order.status}`);
  }
  return lines;
}

function formatOrderResultText(result: { order: OobOrder | null }): string[] {
  return result.order
    ? formatKeyValueBlock([
        ["orderHash", result.order.orderHash],
        ["orderType", result.order.orderType],
        ["status", result.order.status],
        ["priceWei", result.order.priceWei],
        ["collection", result.order.nftContract],
        ["tokenId", result.order.tokenId],
      ])
    : ["order: not found"];
}

function formatBestOrderText(result: { order: OobOrder | null }): string[] {
  return result.order
    ? formatKeyValueBlock([
        ["orderHash", result.order.orderHash],
        ["priceWei", result.order.priceWei],
        ["collection", result.order.nftContract],
        ["tokenId", result.order.tokenId],
      ])
    : ["order: not found"];
}

function formatMarketSnapshotText(result: MarketSnapshotData): string[] {
  return formatKeyValueBlock([
    ["collection", result.collection],
    ["listingCount", result.listingCount],
    ["offerCount", result.offerCount],
    ["floorPriceWei", result.floorPriceWei],
    ["bestListingWei", result.bestListing?.priceWei ?? null],
    ["bestOfferWei", result.bestOffer?.priceWei ?? null],
    ["spreadWei", result.spreadWei],
  ]);
}

function formatTokenSummaryText(result: TokenSummaryData): string[] {
  return formatKeyValueBlock([
    ["collection", result.collection],
    ["tokenId", result.tokenId],
    ["totalOrders", result.totalOrders],
    ["offerCount", result.offerCount],
    ["bestListingWei", result.bestListing?.priceWei ?? null],
    ["bestOfferWei", result.bestOffer?.priceWei ?? null],
  ]);
}

function formatCollectionStatsText(result: CollectionStatsResponse): string[] {
  return formatKeyValueBlock([
    ["collection", result.collection],
    ["chainId", result.chainId],
    ["listingCount", result.listingCount],
    ["floorPriceWei", result.floorPriceWei],
    ["offerCount", result.offerCount],
    ["bestOfferWei", result.bestOfferWei],
  ]);
}

function formatBatchText(result: BatchResult[]): string[] {
  return result.map((item) => `${item.ok ? "ok" : "error"}: ${item.command}`);
}

async function runConfigShow(command: Command, commandName: string): Promise<void> {
  await withConfig(command, commandName, async (config) => ({
    apiKeyConfigured: Boolean(config.apiKey),
    apiUrl: config.apiUrl,
    chainId: config.chainId,
    env: config.env,
    output: config.output,
  }), formatConfigShowText);
}

async function runConfigDoctor(command: Command, commandName: string): Promise<void> {
  await withConfig(command, commandName, async (config, client) => getDoctorData(config, client), formatDoctorText);
}

async function runConfigCheck(command: Command, commandName: string): Promise<void> {
  await withConfig(command, commandName, async (_config, client) => ({
    reachable: true,
    protocolConfig: await client.getProtocolConfig(),
  }), formatConfigCheckText);
}

async function runOrdersList(command: Command, commandName: string): Promise<void> {
  await withConfig(command, commandName, async (_config, client) => {
    const options = getLocalOptions<OrdersListOptions>(command);
    return client.getOrders({
      collection: options.collection,
      tokenId: options.tokenId,
      type: options.type as OrderType | undefined,
      offerer: options.offerer,
      status: options.status as OrderStatus | undefined,
      sortBy: options.sortBy as SortBy | undefined,
      limit: options.limit ? parseNumber(options.limit, "limit") : undefined,
      offset: options.offset ? parseNumber(options.offset, "offset") : undefined,
    });
  }, formatOrdersListText);
}

async function runOrderGet(command: Command, commandName: string, orderHash: string): Promise<void> {
  await withConfig(command, commandName, async (_config, client) => ({
    order: (await client.getOrder(orderHash)).order,
  }), formatOrderResultText);
}

async function runBestOrder(command: Command, commandName: string, side: "listing" | "offer"): Promise<void> {
  await withConfig(command, commandName, async (_config, client) => {
    const options = getLocalOptions<BestOrderOptions>(command);
    const order = side === "listing"
      ? (await client.getBestListing({ collection: options.collection, tokenId: options.tokenId })).order
      : (await client.getBestOffer({ collection: options.collection, tokenId: options.tokenId })).order;
    return { order };
  }, formatBestOrderText);
}

async function runMarketSnapshot(command: Command, commandName: string): Promise<void> {
  await withConfig(command, commandName, async (_config, client) => {
    const options = getLocalOptions<MarketTargetOptions>(command);
    return getMarketSnapshotData(client, options.collection);
  }, formatMarketSnapshotText);
}

async function runTokenSummary(command: Command, commandName: string): Promise<void> {
  await withConfig(command, commandName, async (_config, client) => {
    const options = getLocalOptions<MarketTargetOptions>(command);
    const tokenId = normalizeRequiredString(options.tokenId, "tokenId");
    return getTokenSummaryData(client, options.collection, tokenId);
  }, formatTokenSummaryText);
}

async function runCollectionStats(command: Command, commandName: string, collection: string): Promise<void> {
  await withConfig(command, commandName, async (_config, client) => client.getCollectionStats(collection), formatCollectionStatsText);
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

function emitError(commandName: string, config: RuntimeConfig | undefined, error: unknown): void {
  const classified = classifyError(error);
  const output = config?.output ?? DEFAULT_OUTPUT;
  const payload = {
    name: classified.name,
    code: classified.code,
    message: classified.message,
    status: classified.status,
  };

  if (output === "json") {
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

async function withConfig<T>(command: Command, commandName: string, action: (config: RuntimeConfig, client: CliApiClient) => Promise<T>, text: (result: T) => string[]): Promise<void> {
  let config: RuntimeConfig | undefined;
  try {
    config = resolveConfig(command);
    const client = getClient(config);
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

function addGlobalOptions(program: Command): Command {
  return program
    .option("--chain-id <number>", "Chain ID override")
    .option("--api-url <url>", "API base URL override")
    .option("--api-key <key>", "API key override")
    .option("--env <name>", "Environment label for the current run")
    .option("--output <format>", "Output format: json, jsonl, or text")
    .option("--field <path>", "Return only a nested field from the success payload, e.g. data.order.orderHash")
    .option("--raw", "Print the selected value without JSON wrapper formatting")
    .option("--watch", "Repeat the command on an interval until interrupted")
    .option("--interval <seconds>", "Polling interval in seconds when --watch is enabled")
    .option("--json", "Force JSON output")
    .option("--jsonl", "Force JSONL output")
    .option("--text", "Force text output");
}

export function buildProgram(): Command {
  installActionCompatibility();

  const program = addGlobalOptions(
    new Command()
      .name("oob")
      .description("Open Order Book CLI for agents and power users")
      .version("0.1.0"),
  );

  const configCommand = program.command("config").description("Inspect resolved runtime configuration");

  configCommand
    .command("show")
    .description("Show the resolved configuration after applying flags, env vars, and defaults")
    .action(async function (this: Command) {
      await runConfigShow(this, "config show");
    });

  program
    .command("config-doctor")
    .description("Compatibility alias for config doctor")
    .action(async function (this: Command) {
      await runConfigDoctor(this, "config doctor");
    });

  program
    .command("config-show")
    .description("Compatibility alias for config show")
    .action(async function (this: Command) {
      await runConfigShow(this, "config show");
    });

  configCommand
    .command("doctor")
    .description("Run a machine-friendly runtime diagnostic")
    .action(async function (this: Command) {
      await runConfigDoctor(this, "config doctor");
    });

  configCommand
    .command("check")
    .description("Verify connectivity to the configured API")
    .action(async function (this: Command) {
      await runConfigCheck(this, "config check");
    });

  program
    .command("config-check")
    .description("Compatibility alias for config check")
    .action(async function (this: Command) {
      await runConfigCheck(this, "config check");
    });

  program
    .command("health")
    .description("Alias for config check")
    .action(async function (this: Command) {
      await runConfigCheck(this, "health");
    });

  program
    .command("doctor")
    .description("Alias for config doctor")
    .action(async function (this: Command) {
      await runConfigDoctor(this, "doctor");
    });

  const ordersCommand = program.command("orders").description("Read order book data");

  ordersCommand
    .command("list")
    .description("List orders with optional filters")
    .option("--collection <address>", "Collection address")
    .option("--token-id <tokenId>", "Token ID")
    .option("--type <type>", "Order type: listing or offer")
    .option("--offerer <address>", "Offerer address")
    .option("--status <status>", "Order status")
    .option("--sort-by <sortBy>", "Sort mode")
    .option("--limit <number>", "Limit")
    .option("--offset <number>", "Offset")
    .action(async function (this: Command) {
      await runOrdersList(this, "orders list");
    });

  program
    .command("list")
    .description("Alias for orders list")
    .option("--collection <address>", "Collection address")
    .option("--token-id <tokenId>", "Token ID")
    .option("--type <type>", "Order type: listing or offer")
    .option("--offerer <address>", "Offerer address")
    .option("--status <status>", "Order status")
    .option("--sort-by <sortBy>", "Sort mode")
    .option("--limit <number>", "Limit")
    .option("--offset <number>", "Offset")
    .action(async function (this: Command) {
      await runOrdersList(this, "list");
    });

  ordersCommand
    .command("get <orderHash>")
    .description("Get a single order by hash")
    .action(async function (this: Command, orderHash: string) {
      await runOrderGet(this, "orders get", orderHash);
    });

  program
    .command("get <orderHash>")
    .description("Alias for orders get")
    .action(async function (this: Command, orderHash: string) {
      await runOrderGet(this, "get", orderHash);
    });

  ordersCommand
    .command("best-listing")
    .description("Get the best active listing for a collection or token")
    .requiredOption("--collection <address>", "Collection address")
    .option("--token-id <tokenId>", "Token ID")
    .action(async function (this: Command) {
      await runBestOrder(this, "orders best-listing", "listing");
    });

  program
    .command("best-listing")
    .description("Alias for orders best-listing")
    .requiredOption("--collection <address>", "Collection address")
    .option("--token-id <tokenId>", "Token ID")
    .action(async function (this: Command) {
      await runBestOrder(this, "best-listing", "listing");
    });

  ordersCommand
    .command("best-offer")
    .description("Get the best active offer for a collection or token")
    .requiredOption("--collection <address>", "Collection address")
    .option("--token-id <tokenId>", "Token ID")
    .action(async function (this: Command) {
      await runBestOrder(this, "orders best-offer", "offer");
    });

  program
    .command("best-offer")
    .description("Alias for orders best-offer")
    .requiredOption("--collection <address>", "Collection address")
    .option("--token-id <tokenId>", "Token ID")
    .action(async function (this: Command) {
      await runBestOrder(this, "best-offer", "offer");
    });

  const collectionsCommand = program.command("collections").description("Read collection-level market data");

  const marketCommand = program.command("market").description("Read higher-level market summaries");

  marketCommand
    .command("snapshot")
    .description("Get a collection-level market snapshot")
    .requiredOption("--collection <address>", "Collection address")
    .action(async function (this: Command) {
      await runMarketSnapshot(this, "market snapshot");
    });

  marketCommand
    .command("token-summary")
    .description("Get a token-level market summary")
    .requiredOption("--collection <address>", "Collection address")
    .requiredOption("--token-id <tokenId>", "Token ID")
    .action(async function (this: Command) {
      await runTokenSummary(this, "market token-summary");
    });

  program
    .command("snapshot")
    .description("Alias for market snapshot")
    .requiredOption("--collection <address>", "Collection address")
    .action(async function (this: Command) {
      await runMarketSnapshot(this, "snapshot");
    });

  program
    .command("token-summary")
    .description("Alias for market token-summary")
    .requiredOption("--collection <address>", "Collection address")
    .requiredOption("--token-id <tokenId>", "Token ID")
    .action(async function (this: Command) {
      await runTokenSummary(this, "token-summary");
    });

  const batchCommand = program.command("batch").description("Run multiple read-only requests from JSON or JSONL input");

  batchCommand
    .command("run")
    .description("Execute batch requests from --file or --stdin")
    .option("--file <path>", "Read batch requests from a file")
    .option("--stdin", "Read batch requests from stdin")
    .action(async function (this: Command) {
      await runBatch(this, "batch run");
    });

  program
    .command("batch-run")
    .description("Compatibility alias for batch run")
    .option("--file <path>", "Read batch requests from a file")
    .option("--stdin", "Read batch requests from stdin")
    .action(async function (this: Command) {
      await runBatch(this, "batch run");
    });

  collectionsCommand
    .command("stats <collection>")
    .description("Get collection stats")
    .action(async function (this: Command, collection: string) {
      await runCollectionStats(this, "collections stats", collection);
    });

  program
    .command("stats <collection>")
    .description("Alias for collections stats")
    .action(async function (this: Command, collection: string) {
      await runCollectionStats(this, "stats", collection);
    });

  return program;
}

export async function runCli(argv: string[] = process.argv): Promise<void> {
  const program = buildProgram();
  await program.parseAsync(normalizeArgvForLegacyCommander(argv));
  if (pendingActionPromises.size > 0) {
    await Promise.allSettled(Array.from(pendingActionPromises));
  }
}
