/**
 * Setup wizard — interactive first-time configuration.
 *
 * Usage:
 *   oob setup
 */
import { createInterface } from "node:readline/promises";
import { writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { resolveConfig } from "../config.js";
import { emitError, renderSuccess } from "../output/index.js";
import type { RuntimeConfig } from "../types.js";

async function prompt(rl: ReturnType<typeof createInterface>, question: string, defaultValue?: string): Promise<string> {
  const suffix = defaultValue ? ` [${defaultValue}]` : "";
  const answer = await rl.question(`${question}${suffix}: `);
  return answer.trim() || defaultValue || "";
}

async function runSetup(command: Command): Promise<void> {
  let config: RuntimeConfig | undefined;
  try {
    config = resolveConfig(command);

    process.stderr.write("\n  🔧 OOB CLI Setup Wizard\n\n");

    const rl = createInterface({ input: process.stdin, output: process.stderr });

    try {
      const apiUrl = await prompt(rl, "API URL", "https://api.openorderbook.xyz");
      const chainId = await prompt(rl, "Chain ID (1=Ethereum, 8453=Base, 84532=Base Sepolia)", "8453");
      const apiKey = await prompt(rl, "API Key (optional, press Enter to skip)");
      const rpcUrl = await prompt(rl, "RPC URL (optional, press Enter for default)");
      const output = await prompt(rl, "Default output format (json/jsonl/text/toon/table)", "json");

      const envLines: string[] = [];
      if (apiUrl !== "https://api.openorderbook.xyz") envLines.push(`OOB_API_URL=${apiUrl}`);
      if (chainId !== "8453") envLines.push(`OOB_CHAIN_ID=${chainId}`);
      if (apiKey) envLines.push(`OOB_API_KEY=${apiKey}`);
      if (rpcUrl) envLines.push(`OOB_RPC_URL=${rpcUrl}`);
      if (output !== "json") envLines.push(`OOB_OUTPUT=${output}`);

      process.stderr.write("\n  Configuration:\n");
      process.stderr.write(`    API URL:  ${apiUrl}\n`);
      process.stderr.write(`    Chain ID: ${chainId}\n`);
      process.stderr.write(`    API Key:  ${apiKey ? "***" : "(none)"}\n`);
      process.stderr.write(`    RPC URL:  ${rpcUrl || "(default)"}\n`);
      process.stderr.write(`    Output:   ${output}\n\n`);

      if (envLines.length > 0) {
        const saveChoice = await prompt(rl, "Save to ~/.oob/env? (y/n)", "y");
        if (saveChoice.toLowerCase() === "y") {
          const dir = join(homedir(), ".oob");
          await mkdir(dir, { recursive: true });
          const envPath = join(dir, "env");
          await writeFile(envPath, envLines.join("\n") + "\n", "utf8");
          process.stderr.write(`  ✅ Configuration saved to ${envPath}\n`);
          process.stderr.write(`  💡 Add 'source ~/.oob/env' to your shell profile, or set env vars manually.\n\n`);
        }
      } else {
        process.stderr.write("  ℹ️  All defaults — no config file needed.\n\n");
      }

      renderSuccess("setup", config, {
        apiUrl,
        chainId: Number(chainId),
        apiKeyConfigured: !!apiKey,
        rpcUrl: rpcUrl || null,
        output,
        saved: envLines.length > 0,
      }, [
        `Setup complete. API: ${apiUrl}, Chain: ${chainId}`,
      ]);
    } finally {
      rl.close();
    }
  } catch (error) {
    emitError("setup", config, error);
  }
}

export function registerSetupCommands(program: Command): void {
  program
    .command("setup")
    .description("Interactive first-time configuration wizard")
    .action(async function (this: Command) {
      await runSetup(this);
    });
}
