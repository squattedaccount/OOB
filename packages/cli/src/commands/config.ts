import { Command } from "commander";
import type { CliApiClient } from "../client.js";
import { formatKeyValueBlock } from "../output/index.js";
import { withConfig } from "../runtime.js";
import type { ConfigDoctorData, OutputFormat, ProtocolConfigResponse, RuntimeConfig } from "../types.js";

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

function formatProtocolConfigText(result: ProtocolConfigResponse): string[] {
  return formatKeyValueBlock([
    ["protocolFeeBps", result.protocolFeeBps],
    ["protocolFeeRecipient", result.protocolFeeRecipient],
  ]);
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

async function runConfigShow(command: Command, commandName: string): Promise<void> {
  await withConfig(command, commandName, async (config) => ({
    apiKeyConfigured: Boolean(config.apiKey),
    apiUrl: config.apiUrl,
    chainId: config.chainId,
    dryRun: config.dryRun,
    env: config.env,
    humanPrices: config.humanPrices,
    output: config.output,
    yes: config.yes,
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

async function runConfigProtocol(command: Command, commandName: string): Promise<void> {
  await withConfig(command, commandName, async (_config, client) => {
    return client.getProtocolConfig();
  }, formatProtocolConfigText);
}

export function registerConfigCommands(program: Command): void {
  const configCommand = program.command("config").description("Inspect resolved runtime configuration");

  configCommand
    .command("show")
    .description("Show the resolved configuration after applying flags, env vars, and defaults")
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

  configCommand
    .command("protocol")
    .description("Show protocol fee configuration from the API")
    .action(async function (this: Command) {
      await runConfigProtocol(this, "config protocol");
    });

  // Compatibility aliases on root program
  program
    .command("config-show")
    .description("Compatibility alias for config show")
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
    .command("config-check")
    .description("Compatibility alias for config check")
    .action(async function (this: Command) {
      await runConfigCheck(this, "config check");
    });

  program
    .command("config-protocol")
    .description("Compatibility alias for config protocol")
    .action(async function (this: Command) {
      await runConfigProtocol(this, "config protocol");
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
}
