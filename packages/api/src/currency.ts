/**
 * Currency metadata resolution — maps (chainId, currencyAddress) to symbol + decimals.
 *
 * Native tokens use the zero address (0x000...000).
 * Known ERC-20s are resolved from a static registry (no RPC calls needed).
 * Unknown tokens return a shortened address as symbol with 18 decimals as fallback.
 */

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

interface CurrencyMeta {
  symbol: string;
  decimals: number;
}

// ─── Per-chain native token config ──────────────────────────────────────────

const NATIVE_TOKENS: Record<number, CurrencyMeta> = {
  1:      { symbol: "ETH",  decimals: 18 },
  8453:   { symbol: "ETH",  decimals: 18 },
  84532:  { symbol: "ETH",  decimals: 18 },
  999:    { symbol: "HYPE", decimals: 18 },
  2020:   { symbol: "RON",  decimals: 18 },
  202601: { symbol: "STT",  decimals: 18 },
  2741:   { symbol: "ETH",  decimals: 18 },
};

// ─── Known ERC-20 tokens per chain ──────────────────────────────────────────
// Keys are lowercase addresses.

const KNOWN_TOKENS: Record<number, Record<string, CurrencyMeta>> = {
  // Ethereum Mainnet
  1: {
    "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2": { symbol: "WETH",  decimals: 18 },
    "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48": { symbol: "USDC",  decimals: 6 },
    "0xdac17f958d2ee523a2206206994597c13d831ec7": { symbol: "USDT",  decimals: 6 },
    "0x6b175474e89094c44da98b954eedeac495271d0f": { symbol: "DAI",   decimals: 18 },
  },
  // Base
  8453: {
    "0x4200000000000000000000000000000000000006": { symbol: "WETH",  decimals: 18 },
    "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913": { symbol: "USDC",  decimals: 6 },
    "0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca": { symbol: "USDbC", decimals: 6 },
    "0x50c5725949a6f0c72e6c4a641f24049a917db0cb": { symbol: "DAI",   decimals: 18 },
  },
  // Base Sepolia
  84532: {
    "0x4200000000000000000000000000000000000006": { symbol: "WETH", decimals: 18 },
  },
  // Hyperliquid
  999: {
    // Add known wrapped/stablecoin addresses when available
  },
  // Ronin
  2020: {
    "0xe514d9deb7966c8be0ca922de8a064264ea6bcd4": { symbol: "WRON",  decimals: 18 },
    "0x0b7007c13325c48911f73a2dad5fa5dcbf808adc": { symbol: "USDC",  decimals: 6 },
    "0xc99a6a985ed2cac1ef41640596c5a5f9f4e19ef5": { symbol: "WETH",  decimals: 18 },
  },
  // Abstract
  2741: {
    // Add known wrapped/stablecoin addresses when available
  },
};

/**
 * Resolve currency metadata for a given chain + currency address.
 * Returns symbol, decimals, and whether it's the native token.
 */
export function resolveCurrency(
  chainId: number,
  currencyAddress: string | null | undefined,
): { currencySymbol: string; currencyDecimals: number; isNative: boolean } {
  const addr = (currencyAddress || ZERO_ADDRESS).toLowerCase();

  // Native token
  if (addr === ZERO_ADDRESS) {
    const native = NATIVE_TOKENS[chainId];
    if (native) {
      return { currencySymbol: native.symbol, currencyDecimals: native.decimals, isNative: true };
    }
    return { currencySymbol: "ETH", currencyDecimals: 18, isNative: true };
  }

  // Known ERC-20
  const chainTokens = KNOWN_TOKENS[chainId];
  if (chainTokens && chainTokens[addr]) {
    return { currencySymbol: chainTokens[addr].symbol, currencyDecimals: chainTokens[addr].decimals, isNative: false };
  }

  // Unknown token — return shortened address
  return {
    currencySymbol: `${addr.slice(0, 6)}…${addr.slice(-4)}`,
    currencyDecimals: 18,
    isNative: false,
  };
}

/**
 * Format a wei amount as a human-readable decimal string.
 * E.g. "1000000000000000000" with 18 decimals → "1.0"
 */
export function formatPriceDecimal(priceWei: string | null | undefined, decimals: number): string | null {
  if (!priceWei) return null;
  try {
    const wei = BigInt(priceWei);
    const divisor = 10n ** BigInt(decimals);
    const whole = wei / divisor;
    const remainder = wei % divisor;
    if (remainder === 0n) return whole.toString();
    const fracStr = remainder.toString().padStart(decimals, "0").replace(/0+$/, "");
    return `${whole}.${fracStr}`;
  } catch {
    return null;
  }
}
