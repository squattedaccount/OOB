import { Command } from "commander";
import { getLocalOptions } from "../config.js";
import { formatKeyValueBlock } from "../output/index.js";
import { withConfig } from "../runtime.js";
import { createWalletContext } from "../wallet.js";

interface CheckApprovalOptions {
  collection: string;
}

interface ApproveNftOptions {
  collection: string;
}

interface ApproveErc20Options {
  token: string;
  amount?: string;
}

interface BalanceOptions {
  token?: string;
}

// ─── wallet info ──────────────────────────────────────────────────────────────

async function runWalletInfo(command: Command, commandName: string): Promise<void> {
  await withConfig(command, commandName, async (config) => {
    const ctx = await createWalletContext(config);
    const { formatEther } = await import("viem");
    const balance = await ctx.publicClient.getBalance({ address: ctx.address });
    return {
      address: ctx.address,
      chainId: config.chainId,
      balance: balance.toString(),
      balanceEth: formatEther(balance),
      rpcUrl: config.rpcUrl || "(default)",
    };
  }, (result) => formatKeyValueBlock([
    ["address", result.address],
    ["chainId", result.chainId],
    ["balance", result.balance],
    ["balanceEth", result.balanceEth],
    ["rpcUrl", result.rpcUrl],
  ]));
}

// ─── wallet balance ───────────────────────────────────────────────────────────

async function runWalletBalance(command: Command, commandName: string): Promise<void> {
  await withConfig(command, commandName, async (config) => {
    const ctx = await createWalletContext(config);
    const options = getLocalOptions<BalanceOptions>(command);
    const { formatEther, formatUnits } = await import("viem");

    const ethBalance = await ctx.publicClient.getBalance({ address: ctx.address });
    const result: Record<string, unknown> = {
      address: ctx.address,
      chainId: config.chainId,
      ethBalance: ethBalance.toString(),
      ethBalanceFormatted: formatEther(ethBalance),
    };

    if (options.token) {
      const tokenAddress = options.token.toLowerCase() as `0x${string}`;
      const [tokenBalance, decimals, symbol] = await Promise.all([
        ctx.publicClient.readContract({
          address: tokenAddress as `0x${string}`,
          abi: [{ inputs: [{ name: "account", type: "address" }], name: "balanceOf", outputs: [{ type: "uint256" }], stateMutability: "view", type: "function" }] as const,
          functionName: "balanceOf",
          args: [ctx.address],
        }) as Promise<bigint>,
        ctx.publicClient.readContract({
          address: tokenAddress as `0x${string}`,
          abi: [{ inputs: [], name: "decimals", outputs: [{ type: "uint8" }], stateMutability: "view", type: "function" }] as const,
          functionName: "decimals",
        }).catch(() => 18) as Promise<number>,
        ctx.publicClient.readContract({
          address: tokenAddress as `0x${string}`,
          abi: [{ inputs: [], name: "symbol", outputs: [{ type: "string" }], stateMutability: "view", type: "function" }] as const,
          functionName: "symbol",
        }).catch(() => "UNKNOWN") as Promise<string>,
      ]);

      result.token = tokenAddress;
      result.tokenSymbol = symbol;
      result.tokenBalance = tokenBalance.toString();
      result.tokenBalanceFormatted = formatUnits(tokenBalance, decimals);
    }

    return result;
  }, (result) => {
    const entries: Array<[string, unknown]> = [
      ["address", result.address],
      ["chainId", result.chainId],
      ["ethBalance", result.ethBalance],
      ["ethBalanceFormatted", result.ethBalanceFormatted],
    ];
    if (result.token) {
      entries.push(
        ["token", result.token],
        ["tokenSymbol", result.tokenSymbol],
        ["tokenBalance", result.tokenBalance],
        ["tokenBalanceFormatted", result.tokenBalanceFormatted],
      );
    }
    return formatKeyValueBlock(entries);
  });
}

// ─── wallet check-approval ────────────────────────────────────────────────────

async function runCheckApproval(command: Command, commandName: string): Promise<void> {
  await withConfig(command, commandName, async (config) => {
    const options = getLocalOptions<CheckApprovalOptions>(command);
    const ctx = await createWalletContext(config);

    const isApproved = await ctx.oob.isApproved(options.collection);
    return {
      collection: options.collection,
      owner: ctx.address,
      approvedForSeaport: isApproved,
    };
  }, (result) => formatKeyValueBlock([
    ["collection", result.collection],
    ["owner", result.owner],
    ["approvedForSeaport", result.approvedForSeaport],
  ]));
}

// ─── wallet approve-nft ───────────────────────────────────────────────────────

async function runApproveNft(command: Command, commandName: string): Promise<void> {
  await withConfig(command, commandName, async (config) => {
    const options = getLocalOptions<ApproveNftOptions>(command);

    if (config.dryRun) {
      return {
        dryRun: true,
        action: "approve-nft",
        collection: options.collection,
        chainId: config.chainId,
        message: "Would approve NFT collection for Seaport. Use without --dry-run to execute.",
      };
    }

    const ctx = await createWalletContext(config);
    const txHash = await ctx.oob.approveCollection(options.collection);
    return {
      txHash,
      collection: options.collection,
      chainId: config.chainId,
      owner: ctx.address,
    };
  }, (result) => {
    if (result.dryRun) {
      return formatKeyValueBlock([
        ["dryRun", true],
        ["action", result.action],
        ["collection", result.collection],
      ]);
    }
    return formatKeyValueBlock([
      ["txHash", result.txHash],
      ["collection", result.collection],
      ["owner", result.owner],
    ]);
  });
}

// ─── wallet approve-erc20 ────────────────────────────────────────────────────

async function runApproveErc20(command: Command, commandName: string): Promise<void> {
  await withConfig(command, commandName, async (config) => {
    const options = getLocalOptions<ApproveErc20Options>(command);
    const amount = options.amount ? BigInt(options.amount) : 2n ** 256n - 1n;

    if (config.dryRun) {
      return {
        dryRun: true,
        action: "approve-erc20",
        token: options.token,
        amount: amount.toString(),
        chainId: config.chainId,
        message: "Would approve ERC20 token for Seaport. Use without --dry-run to execute.",
      };
    }

    const ctx = await createWalletContext(config);
    const txHash = await ctx.oob.approveErc20(options.token, amount);
    return {
      txHash,
      token: options.token,
      amount: amount.toString(),
      chainId: config.chainId,
      owner: ctx.address,
    };
  }, (result) => {
    if (result.dryRun) {
      return formatKeyValueBlock([
        ["dryRun", true],
        ["action", result.action],
        ["token", result.token],
        ["amount", result.amount],
      ]);
    }
    return formatKeyValueBlock([
      ["txHash", result.txHash],
      ["token", result.token],
      ["amount", result.amount],
      ["owner", result.owner],
    ]);
  });
}

// ─── Registration ─────────────────────────────────────────────────────────────

export function registerWalletCommands(program: Command): void {
  const walletCommand = program.command("wallet").description("Wallet management and on-chain operations");

  walletCommand
    .command("info")
    .description("Show wallet address, balance, and chain info")
    .action(async function (this: Command) {
      await runWalletInfo(this, "wallet info");
    });

  walletCommand
    .command("balance")
    .description("Show ETH and optional ERC20 token balance")
    .option("--token <address>", "ERC20 token contract address to check balance for")
    .action(async function (this: Command) {
      await runWalletBalance(this, "wallet balance");
    });

  walletCommand
    .command("check-approval")
    .description("Check if NFT collection is approved for Seaport")
    .requiredOption("--collection <address>", "NFT collection address")
    .action(async function (this: Command) {
      await runCheckApproval(this, "wallet check-approval");
    });

  walletCommand
    .command("approve-nft")
    .description("Approve NFT collection for Seaport trading")
    .requiredOption("--collection <address>", "NFT collection address")
    .action(async function (this: Command) {
      await runApproveNft(this, "wallet approve-nft");
    });

  walletCommand
    .command("approve-erc20")
    .description("Approve ERC20 token for Seaport trading (e.g. WETH for offers)")
    .requiredOption("--token <address>", "ERC20 token contract address")
    .option("--amount <wei>", "Approval amount in wei (default: max uint256)")
    .action(async function (this: Command) {
      await runApproveErc20(this, "wallet approve-erc20");
    });

  // Top-level aliases for normalizeArgvForLegacyCommander
  program
    .command("wallet-info")
    .description("Alias for wallet info")
    .action(async function (this: Command) {
      await runWalletInfo(this, "wallet info");
    });

  program
    .command("wallet-balance")
    .description("Alias for wallet balance")
    .option("--token <address>", "ERC20 token contract address to check balance for")
    .action(async function (this: Command) {
      await runWalletBalance(this, "wallet balance");
    });

  program
    .command("wallet-check-approval")
    .description("Alias for wallet check-approval")
    .requiredOption("--collection <address>", "NFT collection address")
    .action(async function (this: Command) {
      await runCheckApproval(this, "wallet check-approval");
    });

  program
    .command("wallet-approve-nft")
    .description("Alias for wallet approve-nft")
    .requiredOption("--collection <address>", "NFT collection address")
    .action(async function (this: Command) {
      await runApproveNft(this, "wallet approve-nft");
    });

  program
    .command("wallet-approve-erc20")
    .description("Alias for wallet approve-erc20")
    .requiredOption("--token <address>", "ERC20 token contract address")
    .option("--amount <wei>", "Approval amount in wei (default: max uint256)")
    .action(async function (this: Command) {
      await runApproveErc20(this, "wallet approve-erc20");
    });
}
