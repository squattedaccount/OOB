import { Command } from "commander";
import { formatKeyValueBlock } from "../output/index.js";
import { withConfig } from "../runtime.js";

function formatApproveTxText(result: { to: string; data: string; value: string }): string[] {
  return formatKeyValueBlock([
    ["to", result.to],
    ["data", result.data],
    ["value", result.value],
  ]);
}

async function runApproveTx(command: Command, commandName: string, tokenAddress: string): Promise<void> {
  await withConfig(command, commandName, async (_config, client) => {
    return client.getApproveTx(tokenAddress);
  }, formatApproveTxText);
}

export function registerApproveCommands(program: Command): void {
  program
    .command("approve-tx <tokenAddress>")
    .description("Build ERC20 approval calldata for Seaport spending")
    .action(async function (this: Command, tokenAddress: string) {
      await runApproveTx(this, "approve-tx", tokenAddress);
    });
}
