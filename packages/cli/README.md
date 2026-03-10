# @oob/cli

`@oob/cli` is the agent-first command line interface for Open Order Book.

It is designed for:

- AI agents running shell commands
- power users scripting order book queries
- CI jobs and automation
- quick inspection without writing SDK code

## Why this CLI exists

The CLI is intentionally:

- non-interactive by default
- JSON-first by default
- easy to run with `npx`
- easy to configure with environment variables

If an agent can run shell commands, it should be able to use OOB immediately.

## Install

### Recommended: one-off usage with `npx`

```bash
npx @oob/cli config check
```

### Global install

```bash
npm install -g @oob/cli
oob config check
```

### Project-local install

```bash
npm install @oob/cli
npx oob config check
```

## Quick start

```bash
npx @oob/cli config show
npx @oob/cli health
npx @oob/cli orders list --collection 0xYourCollection --type listing
npx @oob/cli best-listing --collection 0xYourCollection
npx @oob/cli stats 0xYourCollection
```

## Configuration

Configuration precedence:

1. command flags
2. environment variables
3. built-in defaults

Supported environment variables:

- `OOB_CHAIN_ID`
- `OOB_API_URL`
- `OOB_API_KEY`
- `OOB_ENV`
- `OOB_OUTPUT`
- `OOB_TIMEOUT_MS`
- `OOB_RETRIES`
- `OOB_RETRY_DELAY_MS`

Example:

```bash
OOB_CHAIN_ID=8453 OOB_OUTPUT=json npx @oob/cli best-offer --collection 0xYourCollection
```

## Output

The CLI returns JSON by default so agents can parse it safely.

Successful commands return a shape like:

```json
{
  "ok": true,
  "command": "orders list",
  "data": {},
  "meta": {
    "apiUrl": "https://api.openorderbook.xyz",
    "chainId": 8453,
    "env": "production",
    "output": "json"
  }
}
```

Failed commands return a shape like:

```json
{
  "ok": false,
  "command": "config check",
  "error": {
    "name": "OobApiError",
    "message": "API error 500",
    "status": 500
  }
}
```

If you want human-readable output instead:

```bash
npx @oob/cli --text config show
```

If you want newline-delimited JSON for pipelines or batch jobs:

```bash
npx @oob/cli --jsonl batch run --stdin
```

If you want to extract one field for an agent:

```bash
npx @oob/cli --field data.apiUrl --raw config show
```

If you want bounded and retryable network behavior for automation:

```bash
npx @oob/cli --timeout 8000 --retries 2 --retry-delay 500 health
```

## Exit codes and errors

The CLI uses deterministic exit codes for automation:

- `0` success
- `1` internal error
- `2` not found
- `3` invalid input or batch input error
- `4` auth error
- `5` network or API error

JSON errors also include a machine-readable `error.code` field such as:

- `INVALID_INPUT`
- `NOT_FOUND`
- `AUTH_ERROR`
- `NETWORK_ERROR`
- `API_ERROR`
- `BATCH_INPUT_ERROR`
- `INTERNAL_ERROR`

## Commands

Primary commands:

```bash
oob config show
oob config check
oob config doctor
oob health
oob orders list --collection 0x... --type listing
oob orders get 0x...
oob orders best-listing --collection 0x...
oob orders best-offer --collection 0x...
oob collections stats 0x...
oob market snapshot --collection 0x...
oob market token-summary --collection 0x... --token-id 123
oob batch run --file requests.jsonl
```

Short aliases for agent prompts and quick usage:

```bash
oob doctor
oob list --collection 0x... --type listing
oob get 0x...
oob best-listing --collection 0x...
oob best-offer --collection 0x...
oob snapshot --collection 0x...
oob token-summary --collection 0x... --token-id 123
oob stats 0x...
```

## Common examples

### Check connectivity

```bash
npx @oob/cli health
```

### Run diagnostics for agents

```bash
npx @oob/cli doctor
```

### Get all active listings for a collection

```bash
npx @oob/cli orders list --collection 0xYourCollection --type listing --status active --sort-by price_asc
```

### Get the best listing

```bash
npx @oob/cli best-listing --collection 0xYourCollection
```

### Get the best offer

```bash
npx @oob/cli best-offer --collection 0xYourCollection
```

### Get collection stats

```bash
npx @oob/cli stats 0xYourCollection
```

### Get a market snapshot

```bash
npx @oob/cli snapshot --collection 0xYourCollection
```

### Get a token summary

```bash
npx @oob/cli token-summary --collection 0xYourCollection --token-id 1
```

### Extract a single value for a shell agent

```bash
npx @oob/cli --field data.order.priceWei --raw best-listing --collection 0xYourCollection
```

### Batch multiple requests from JSONL

```bash
printf '%s\n' \
  '{"command":"config.check"}' \
  '{"command":"collections.stats","args":{"collection":"0xYourCollection"}}' \
  | npx @oob/cli --jsonl batch run --stdin
```

### Watch a command over time

```bash
npx @oob/cli --watch --interval 15 snapshot --collection 0xYourCollection
```

### Use an API key

```bash
OOB_API_KEY=your_key_here npx @oob/cli orders list --collection 0xYourCollection
```

## For agents

If you are giving this to an agent, the shortest reliable instruction is:

```bash
Use `npx @oob/cli`.
Prefer default JSON output.
Run `npx @oob/cli health` first.
Use `--field ... --raw` when only one value is needed.
Use `--jsonl` for batch workflows.
If needed, pass `OOB_API_KEY` via environment variable.
```

## Local development

```bash
npm install
npm run check
npm run build
node dist/cli.js health
```

## Publish

```bash
npm pack
npm publish
```
