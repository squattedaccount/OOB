/**
 * Shell completions — generate completion scripts for bash, zsh, and fish.
 *
 * Usage:
 *   oob completions bash >> ~/.bashrc
 *   oob completions zsh >> ~/.zshrc
 *   oob completions fish > ~/.config/fish/completions/oob.fish
 */
import { Command } from "commander";
import { resolveConfig } from "../config.js";
import { renderSuccess, emitError } from "../output/index.js";
import type { RuntimeConfig } from "../types.js";

const COMMANDS = [
  "orders list", "orders get", "orders best-listing", "orders best-offer",
  "orders fill-tx", "orders floor-tx", "orders create-listing", "orders create-offer",
  "orders fill", "orders cancel", "orders sweep", "orders accept-offer",
  "collections stats", "market snapshot", "market token-summary",
  "activity list", "activity order",
  "wallet info", "wallet balance", "wallet check-approval", "wallet approve-nft", "wallet approve-erc20",
  "watch order", "watch price", "watch collection",
  "analyze depth", "analyze spread", "analyze price-history", "analyze portfolio",
  "batch run", "batch execute",
  "config show", "config check", "config protocol",
  "describe", "stream", "setup", "agent manifest", "mcp serve",
];

const GLOBAL_FLAGS = [
  "--chain-id", "--api-url", "--api-key", "--env", "--output", "--field", "--raw",
  "--watch", "--interval", "--timeout", "--retries", "--retry-delay", "--verbose",
  "--max-lines", "--json", "--jsonl", "--text", "--toon", "--table",
  "--human-prices", "--yes", "--private-key", "--rpc-url", "--dry-run",
];

function generateBash(): string {
  const subcommands = COMMANDS.map((c) => c.replace(/ /g, "\\ ")).join(" ");
  const flags = GLOBAL_FLAGS.join(" ");
  return `# oob bash completion
_oob_completions() {
  local cur prev commands flags
  COMPREPLY=()
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"
  commands="${COMMANDS.join(" ")}"
  flags="${flags}"

  case "\${prev}" in
    oob)
      COMPREPLY=( $(compgen -W "orders collections market activity wallet watch analyze batch config describe stream setup agent mcp" -- "\${cur}") )
      return 0
      ;;
    orders)
      COMPREPLY=( $(compgen -W "list get best-listing best-offer fill-tx floor-tx create-listing create-offer fill cancel sweep accept-offer" -- "\${cur}") )
      return 0
      ;;
    wallet)
      COMPREPLY=( $(compgen -W "info balance check-approval approve-nft approve-erc20" -- "\${cur}") )
      return 0
      ;;
    watch)
      COMPREPLY=( $(compgen -W "order price collection" -- "\${cur}") )
      return 0
      ;;
    analyze)
      COMPREPLY=( $(compgen -W "depth spread price-history portfolio" -- "\${cur}") )
      return 0
      ;;
    batch)
      COMPREPLY=( $(compgen -W "run execute" -- "\${cur}") )
      return 0
      ;;
    config)
      COMPREPLY=( $(compgen -W "show check protocol" -- "\${cur}") )
      return 0
      ;;
    --output)
      COMPREPLY=( $(compgen -W "json jsonl text toon table" -- "\${cur}") )
      return 0
      ;;
  esac

  if [[ "\${cur}" == -* ]]; then
    COMPREPLY=( $(compgen -W "${flags}" -- "\${cur}") )
    return 0
  fi
}
complete -F _oob_completions oob
`;
}

function generateZsh(): string {
  return `# oob zsh completion
#compdef oob

_oob() {
  local -a commands subcommands flags

  flags=(
    ${GLOBAL_FLAGS.map((f) => `'${f}[${f.replace("--", "")}]'`).join("\n    ")}
  )

  commands=(
    'orders:Order operations'
    'collections:Collection operations'
    'market:Market analysis'
    'activity:Activity events'
    'wallet:Wallet operations'
    'watch:Monitoring commands'
    'analyze:Analysis commands'
    'batch:Batch operations'
    'config:Configuration'
    'describe:Command schema discovery'
    'stream:Real-time event stream'
    'setup:Setup wizard'
    'agent:Agent tooling'
    'mcp:MCP server'
  )

  _arguments -C \\
    $flags \\
    '1:command:->command' \\
    '*::arg:->args'

  case $state in
    command)
      _describe 'command' commands
      ;;
    args)
      case $words[1] in
        orders)
          subcommands=('list' 'get' 'best-listing' 'best-offer' 'fill-tx' 'floor-tx' 'create-listing' 'create-offer' 'fill' 'cancel' 'sweep' 'accept-offer')
          _describe 'subcommand' subcommands
          ;;
        wallet)
          subcommands=('info' 'balance' 'check-approval' 'approve-nft' 'approve-erc20')
          _describe 'subcommand' subcommands
          ;;
        watch)
          subcommands=('order' 'price' 'collection')
          _describe 'subcommand' subcommands
          ;;
        analyze)
          subcommands=('depth' 'spread' 'price-history' 'portfolio')
          _describe 'subcommand' subcommands
          ;;
        batch)
          subcommands=('run' 'execute')
          _describe 'subcommand' subcommands
          ;;
        config)
          subcommands=('show' 'check' 'protocol')
          _describe 'subcommand' subcommands
          ;;
      esac
      ;;
  esac
}

_oob "$@"
`;
}

function generateFish(): string {
  const lines = [
    "# oob fish completion",
    "",
    "# Top-level commands",
    "complete -c oob -n '__fish_use_subcommand' -a 'orders' -d 'Order operations'",
    "complete -c oob -n '__fish_use_subcommand' -a 'collections' -d 'Collection operations'",
    "complete -c oob -n '__fish_use_subcommand' -a 'market' -d 'Market analysis'",
    "complete -c oob -n '__fish_use_subcommand' -a 'activity' -d 'Activity events'",
    "complete -c oob -n '__fish_use_subcommand' -a 'wallet' -d 'Wallet operations'",
    "complete -c oob -n '__fish_use_subcommand' -a 'watch' -d 'Monitoring commands'",
    "complete -c oob -n '__fish_use_subcommand' -a 'analyze' -d 'Analysis commands'",
    "complete -c oob -n '__fish_use_subcommand' -a 'batch' -d 'Batch operations'",
    "complete -c oob -n '__fish_use_subcommand' -a 'config' -d 'Configuration'",
    "complete -c oob -n '__fish_use_subcommand' -a 'describe' -d 'Command schema discovery'",
    "complete -c oob -n '__fish_use_subcommand' -a 'stream' -d 'Real-time event stream'",
    "complete -c oob -n '__fish_use_subcommand' -a 'setup' -d 'Setup wizard'",
    "complete -c oob -n '__fish_use_subcommand' -a 'agent' -d 'Agent tooling'",
    "complete -c oob -n '__fish_use_subcommand' -a 'mcp' -d 'MCP server'",
    "",
    "# Orders subcommands",
    ...["list", "get", "best-listing", "best-offer", "fill-tx", "floor-tx", "create-listing", "create-offer", "fill", "cancel", "sweep", "accept-offer"]
      .map((s) => `complete -c oob -n '__fish_seen_subcommand_from orders' -a '${s}'`),
    "",
    "# Wallet subcommands",
    ...["info", "balance", "check-approval", "approve-nft", "approve-erc20"]
      .map((s) => `complete -c oob -n '__fish_seen_subcommand_from wallet' -a '${s}'`),
    "",
    "# Watch subcommands",
    ...["order", "price", "collection"]
      .map((s) => `complete -c oob -n '__fish_seen_subcommand_from watch' -a '${s}'`),
    "",
    "# Analyze subcommands",
    ...["depth", "spread", "price-history", "portfolio"]
      .map((s) => `complete -c oob -n '__fish_seen_subcommand_from analyze' -a '${s}'`),
    "",
    "# Global flags",
    ...GLOBAL_FLAGS.map((f) => `complete -c oob -l '${f.replace("--", "")}'`),
  ];
  return lines.join("\n") + "\n";
}

export function registerCompletionsCommands(program: Command): void {
  program
    .command("completions <shell>")
    .description("Generate shell completion script (bash, zsh, or fish)")
    .action(async function (this: Command, shell: string) {
      let config: RuntimeConfig | undefined;
      try {
        config = resolveConfig(this);

        let script: string;
        switch (shell.toLowerCase()) {
          case "bash":
            script = generateBash();
            break;
          case "zsh":
            script = generateZsh();
            break;
          case "fish":
            script = generateFish();
            break;
          default:
            throw new Error(`Unsupported shell: ${shell}. Use bash, zsh, or fish.`);
        }

        // Completions always output raw script to stdout
        process.stdout.write(script);
      } catch (error) {
        emitError("completions", config, error);
      }
    });
}
