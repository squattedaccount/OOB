/**
 * Wallet module — lazily imports viem and @oob/sdk so that read-only CLI
 * commands never pay the import cost (and avoid abitype parse issues).
 */
import { CliError } from "./errors.js";
import type { RuntimeConfig } from "./types.js";

// Re-export viem types for consumers (type-only imports are free)
import type { Address, Hex, PublicClient, WalletClient } from "viem";
export type { Address, Hex, PublicClient, WalletClient };

const DEFAULT_RPC_URLS: Record<number, string> = {
  1: "https://eth.llamarpc.com",
  8453: "https://mainnet.base.org",
  84532: "https://sepolia.base.org",
};

export interface WalletContext {
  walletClient: WalletClient;
  publicClient: PublicClient;
  address: Address;
  oob: InstanceType<Awaited<ReturnType<typeof importSdk>>["OpenOrderBook"]>;
}

// ─── Lazy loaders ───────────────────────────────────────────────────────────

async function importViem() {
  return import("viem");
}

async function importViemAccounts() {
  return import("viem/accounts");
}

async function importViemChains() {
  return import("viem/chains");
}

async function importSdk() {
  return import("@oob/sdk");
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function getRpcUrl(config: RuntimeConfig): string {
  if (config.rpcUrl) return config.rpcUrl;
  const defaultUrl = DEFAULT_RPC_URLS[config.chainId];
  if (defaultUrl) return defaultUrl;
  throw new CliError(
    "INVALID_INPUT",
    3,
    `No default RPC URL for chain ${config.chainId}. Provide --rpc-url or set OOB_RPC_URL.`,
  );
}

export function requirePrivateKey(config: RuntimeConfig): Hex {
  if (!config.privateKey) {
    throw new CliError(
      "INVALID_INPUT",
      3,
      "Private key required for write operations. Set OOB_PRIVATE_KEY env var or pass --private-key.",
    );
  }
  const key = config.privateKey.startsWith("0x")
    ? config.privateKey
    : `0x${config.privateKey}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
    throw new CliError("INVALID_INPUT", 3, "Invalid private key format. Must be a 32-byte hex string.");
  }
  return key as Hex;
}

async function getChain(chainId: number) {
  const viem = await importViem();
  type Chain = Parameters<typeof viem.createPublicClient>[0]["chain"];
  const { base, baseSepolia, mainnet } = await importViemChains();
  const map: Record<number, Chain> = { 1: mainnet, 8453: base, 84532: baseSepolia };
  const chain = map[chainId];
  if (chain) return chain;
  return {
    id: chainId,
    name: `Chain ${chainId}`,
    nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [] } },
  } as Chain;
}

// ─── Public API ─────────────────────────────────────────────────────────────

export async function createPublicClientFromConfig(config: RuntimeConfig): Promise<PublicClient> {
  const { createPublicClient, http } = await importViem();
  const chain = await getChain(config.chainId);
  const rpcUrl = getRpcUrl(config);
  return createPublicClient({ chain, transport: http(rpcUrl) });
}

export async function createWalletContext(config: RuntimeConfig): Promise<WalletContext> {
  // Validate key before heavy imports to give a clean error message
  const key = requirePrivateKey(config);

  const [{ createWalletClient, createPublicClient, http }, { privateKeyToAccount }, { OpenOrderBook }] =
    await Promise.all([importViem(), importViemAccounts(), importSdk()]);
  const account = privateKeyToAccount(key);
  const chain = await getChain(config.chainId);
  const rpcUrl = getRpcUrl(config);

  const walletClient = createWalletClient({ account, chain, transport: http(rpcUrl) });
  const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });

  const oob = new OpenOrderBook({
    chainId: config.chainId,
    apiUrl: config.apiUrl,
    apiKey: config.apiKey,
  });
  oob.connect(walletClient, publicClient);

  return { walletClient, publicClient, address: account.address, oob };
}

export async function createReadOnlyContext(config: RuntimeConfig) {
  const [{ createPublicClient, http }, { OpenOrderBook }] =
    await Promise.all([importViem(), importSdk()]);

  const chain = await getChain(config.chainId);
  const rpcUrl = getRpcUrl(config);
  const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });

  const oob = new OpenOrderBook({
    chainId: config.chainId,
    apiUrl: config.apiUrl,
    apiKey: config.apiKey,
  });

  return { publicClient, oob };
}
