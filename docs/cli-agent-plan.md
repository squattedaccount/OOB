# OOB CLI — AI-Agent-First Plan

> Comprehensive analysis, gap assessment, and implementation roadmap for making the OOB CLI the best access layer for AI agents interacting with the Open Order Book.

---

## Table of Contents

- [1. Executive Summary](#1-executive-summary)
- [2. Current OOB System Inventory](#2-current-oob-system-inventory)
- [3. Current OOB CLI Capabilities](#3-current-oob-cli-capabilities)
- [4. Competitor Analysis (OpenSea CLI)](#4-competitor-analysis-opensea-cli)
- [5. Gap Analysis — OOB CLI vs Competitor](#5-gap-analysis--oob-cli-vs-competitor)
- [6. OOB Advantages & Unique Opportunities](#6-oob-advantages--unique-opportunities)
- [7. AI-Agent Design Principles](#7-ai-agent-design-principles)
- [8. Feature Roadmap](#8-feature-roadmap)
- [9. Architecture & Refactoring Plan](#9-architecture--refactoring-plan)
- [10. API & Backend Modifications](#10-api--backend-modifications)
- [11. SDK Modifications](#11-sdk-modifications)
- [12. Output Formats for Agents](#12-output-formats-for-agents)
- [13. Human UX Layer (Phase 2)](#13-human-ux-layer-phase-2)
- [14. Testing Strategy](#14-testing-strategy)
- [15. Implementation Phases](#15-implementation-phases)

---

## 1. Executive Summary

The OOB CLI today is a **read-only** tool with solid foundations: structured JSON/JSONL/text output, `--watch` polling, `--field` extraction, batch requests, retry logic, and proper exit codes. However, it **cannot execute any write operations** (create orders, fill orders, cancel orders) and has no wallet integration — making it unsuitable as an autonomous agent access layer.

The competitor (OpenSea CLI) is also read-only but covers a broader surface area (events, search, NFT metadata, tokens, swaps, accounts) and offers a TOON output format optimized for LLM token efficiency.

**Our key advantage**: OOB is an **open protocol on Seaport v1.6** with direct on-chain settlement. Unlike OpenSea's centralized API wrapper, we can offer **full write capabilities** — agents can autonomously create listings, make offers, fill orders, cancel orders, and sweep floors, all through the CLI. This is our moat.

**Goal**: Build the CLI into a complete agent toolkit that supports the full order lifecycle (read → analyze → decide → execute → monitor), with structured output optimized for LLM consumption.

---

## 2. Current OOB System Inventory

### 2.1 API (`packages/api/`)

Cloudflare Worker at `api.openorderbook.xyz`. Full REST + WebSocket.

| Category | Endpoints | Notes |
|---|---|---|
| **Orders — Read** | `GET /v1/orders`, `GET /v1/orders/:hash`, `GET /v1/orders/:hash/activity`, `GET /v1/orders/best-listing`, `GET /v1/orders/best-offer` | Full query filters, pagination |
| **Orders — Write** | `POST /v1/orders`, `POST /v1/orders/batch`, `DELETE /v1/orders/:hash`, `DELETE /v1/orders/batch` | Submit, cancel, batch operations |
| **Fill Tx** | `GET /v1/orders/:hash/fill-tx`, `GET /v1/orders/best-listing/fill-tx`, `POST /v1/orders/batch/fill-tx` | Ready-to-sign calldata |
| **Collections** | `GET /v1/collections/:addr/stats` | Floor, offer count, listing count |
| **Config** | `GET /v1/config`, `GET /health` | Protocol fees, health |
| **ERC20** | `GET /v1/erc20/:token/approve-tx` | Approval calldata |
| **Stream** | `WSS /v1/stream` | Real-time order events via Durable Objects |
| **Auth/Subs** | Auth nonce, verify, projects, plans, API keys, payments | Full subscription management |

**Key insight**: The API already supports everything an agent needs. The CLI just doesn't expose most of it.

### 2.2 SDK (`packages/sdk/`)

TypeScript SDK with `viem` for on-chain operations.

| Capability | Method | CLI Exposure |
|---|---|---|
| Get orders | `getOrders()` | ✅ Yes |
| Get single order | `getOrder()` | ✅ Yes |
| Best listing | `getBestListing()` | ✅ Yes |
| Best offer | `getBestOffer()` | ✅ Yes |
| Collection stats | `getCollectionStats()` | ✅ Yes |
| Create listing | `createListing()` | ❌ No |
| Create offer | `createOffer()` | ❌ No |
| Create targeted offer | `createTargetedOffer()` | ❌ No |
| Accept open offer | `acceptOpenOffer()` | ❌ No |
| Fill order | `fillOrder()` | ❌ No |
| Cancel order | `cancelOrder()` | ❌ No |
| Check approvals | `ensureNftApproval()`, `ensureErc20Ready()` | ❌ No |
| Subscribe (WS) | `subscribe()` | ❌ No |
| Protocol config | `getConfig()` | ✅ Partial (via health) |
| Activity | via API | ❌ No |

### 2.3 CLI (`packages/cli/`)

| Command | Description | Type |
|---|---|---|
| `config show` | Show resolved config | Read |
| `config doctor` | Runtime diagnostics | Read |
| `config check` / `health` | API connectivity check | Read |
| `orders list` | List orders with filters | Read |
| `orders get <hash>` | Get single order | Read |
| `orders best-listing` | Best listing for collection/token | Read |
| `orders best-offer` | Best offer for collection/token | Read |
| `collections stats <addr>` | Collection stats | Read |
| `market snapshot` | Collection market snapshot | Read |
| `market token-summary` | Token market summary | Read |
| `batch run` | Batch read requests | Read |

**Global options**: `--chain-id`, `--api-url`, `--api-key`, `--env`, `--output` (json/jsonl/text), `--field`, `--raw`, `--watch`, `--interval`, `--timeout`, `--retries`, `--retry-delay`

### 2.4 Indexer (`packages/indexer/`)

Cloudflare Worker monitoring Seaport on-chain events:
- Webhook ingest (Alchemy, Moralis, Goldsky)
- `OrderFulfilled` → `filled`, `OrderCancelled` → `cancelled`, `CounterIncremented` → bulk cancel
- ERC-721 `Transfer` → staleness detection
- Cron: expiry + round-robin ownership checks

---

## 3. Current OOB CLI Capabilities

### 3.1 Strengths

- **Structured output**: JSON (pretty), JSONL (streaming), text (human) — great for agent parsing
- **`--field` extraction**: Agents can extract specific nested fields, e.g. `--field data.order.priceWei`
- **`--raw`**: Strip JSON wrapper, output raw value — ideal for piping
- **`--watch` + `--interval`**: Polling loop for monitoring
- **Batch requests**: Multiple read operations from JSON/JSONL input via `batch run`
- **Retry logic**: Configurable retries with exponential backoff
- **Proper exit codes**: Structured error classification (API_ERROR, AUTH_ERROR, NETWORK_ERROR, INVALID_INPUT)
- **Env var config**: `OOB_API_URL`, `OOB_CHAIN_ID`, `OOB_API_KEY`, `OOB_ENV`
- **Market snapshots**: Composite views (floor, best offer, spread, order counts, depth) — unique to OOB

### 3.2 Weaknesses

- **No write operations at all** — cannot create/fill/cancel orders
- **No wallet integration** — no private key or keystore support
- **No WebSocket streaming** — only polling via `--watch`
- **No activity/events** — cannot query order history
- **No fill-tx building** — cannot generate transaction calldata
- **No approval checking** — cannot verify NFT/ERC20 approvals
- **No account management** — no auth, projects, API key management
- **Single-file architecture** — entire CLI is in one 1374-line file
- **No programmatic SDK export** — CLI is not usable as a library

---

## 4. Competitor Analysis (OpenSea CLI)

### 4.1 Architecture

| Aspect | OpenSea CLI | OOB CLI |
|---|---|---|
| **Package** | `@opensea/cli` v0.4.2 | `@oob/cli` v0.1.0 |
| **Framework** | `commander` + `zod` | `commander` |
| **Build** | `tsup` | `tsup` |
| **Structure** | Modular (10 command files, client, sdk, output, toon, types) | Monolithic (1 main file) |
| **SDK export** | Yes — `OpenSeaCLI` class with sub-APIs | No |
| **Validation** | `zod` schemas | Manual parsing |
| **Error class** | `OpenSeaAPIError` (statusCode, responseBody, path) | `CliError` + `OobApiError` (code, exitCode, message) |

### 4.2 Features

| Feature | OpenSea CLI | OOB CLI |
|---|---|---|
| **Collections** — get, list, stats, traits | ✅ | ✅ Partial (stats only) |
| **NFTs** — get, list by collection/contract/account, refresh, contract info | ✅ | ❌ |
| **Listings** — all, best, best-for-nft | ✅ | ✅ (best-listing, best-offer) |
| **Offers** — all, collection, best-for-nft, traits | ✅ | ✅ Partial (best-offer) |
| **Events** — list, by-account, by-collection, by-nft | ✅ | ❌ |
| **Search** — collections, NFTs, tokens, accounts | ✅ | ❌ |
| **Tokens** — trending, top, get details | ✅ | ❌ (N/A for OOB) |
| **Swaps** — quote | ✅ | ❌ (N/A for OOB) |
| **Accounts** — get | ✅ | ❌ |
| **Health** — connectivity + auth check | ✅ | ✅ |
| **Write operations** | ❌ | ❌ (but OOB API supports them!) |
| **Wallet integration** | ❌ | ❌ |
| **WebSocket streaming** | ❌ | ❌ |

### 4.3 Output Formats

| Format | OpenSea CLI | OOB CLI |
|---|---|---|
| **JSON** | ✅ (default) | ✅ (default) |
| **JSONL** | ❌ | ✅ |
| **Table** | ✅ | ✅ (text mode) |
| **TOON** | ✅ (~40% fewer tokens than JSON) | ❌ |
| **Field filtering** | ✅ (`--fields`) | ✅ (`--field`) |
| **Output truncation** | ✅ (`--max-lines`) | ❌ |
| **Raw value** | ❌ | ✅ (`--raw`) |

### 4.4 Agent-Friendly Features

| Feature | OpenSea CLI | OOB CLI |
|---|---|---|
| **TOON format** (LLM token reduction) | ✅ | ❌ |
| **Structured errors** | ✅ (JSON to stderr) | ✅ (JSON/JSONL/text to stderr) |
| **Exit codes** | 0/1/2/3 | 0–5 (more granular) |
| **Batch operations** | ❌ | ✅ |
| **Watch/poll mode** | ❌ | ✅ |
| **Verbose logging** | ✅ (`--verbose`) | ❌ |
| **Retry with backoff** | ✅ (configurable) | ✅ (configurable) |
| **Programmatic SDK** | ✅ (`OpenSeaCLI` class) | ❌ |
| **Pagination cursors** | ✅ (`--next`) | ✅ (`--offset`) |

---

## 5. Gap Analysis — OOB CLI vs Competitor

### 5.1 Critical Gaps (Must Fix)

| Gap | Impact | Priority |
|---|---|---|
| **No write operations** (create/fill/cancel) | Agents cannot execute trades | 🔴 P0 |
| **No wallet integration** | Cannot sign orders or transactions | 🔴 P0 |
| **No activity/events query** | Cannot track order history | 🟠 P1 |
| **No WebSocket streaming** | Must poll instead of react to real-time events | 🟠 P1 |
| **No fill-tx command** | Cannot build ready-to-sign transaction calldata | 🟠 P1 |
| **Monolithic architecture** | Hard to extend and maintain | 🟠 P1 |

### 5.2 Feature Gaps (Should Add)

| Gap | Impact | Priority |
|---|---|---|
| **No TOON / compact output** | Higher LLM token usage | 🟡 P2 |
| **No approval check commands** | Agent can't verify pre-conditions | 🟡 P2 |
| **No verbose/debug mode** | Harder to troubleshoot agent pipelines | 🟡 P2 |
| **No output truncation** | Large responses waste context window | 🟡 P2 |
| **No programmatic SDK export** | Can't use CLI as a library | 🟡 P2 |
| **No auth/project management** | Can't self-service API keys | 🟢 P3 |
| **No `--max-lines`** | Can't limit output size | 🟢 P3 |

### 5.3 Things OOB Does Better

| Feature | Advantage |
|---|---|
| **JSONL output** | Better for streaming/piping than competitor |
| **`--field` + `--raw`** | More powerful data extraction |
| **`--watch` polling** | Built-in monitoring loop |
| **Batch requests** | Multiple operations in one call |
| **Market snapshots** | Composite views (spread, depth) not available in competitor |
| **Granular exit codes** | 5 distinct codes vs competitor's 3 |
| **Env var cascade** | Full config resolution chain |

---

## 6. OOB Advantages & Unique Opportunities

### 6.1 Structural Advantages Over OpenSea CLI

1. **Full write capability potential** — OOB API supports POST/DELETE for orders. OpenSea API is read-only for third parties. This is our biggest differentiator.

2. **On-chain execution** — OOB SDK can sign and submit Seaport transactions. Agents can go from decision → execution in one tool.

3. **WebSocket streaming** — OOB API has real-time event streams via Durable Objects. Agents can subscribe and react instantly.

4. **Open protocol** — OOB orders are Seaport v1.6 standard. Orders created through our CLI can be filled by anyone on any Seaport-compatible marketplace.

5. **Fill-tx endpoint** — The API can build ready-to-sign calldata. Agents don't need to understand Seaport internals.

6. **Multi-chain from day one** — Base, Ethereum, Hyperliquid, Ronin, Abstract.

### 6.2 Unique Agent Features to Build

1. **`oob execute` commands** — Full order lifecycle: list, offer, fill, cancel, sweep
2. **`oob stream`** — Real-time WebSocket events piped as JSONL
3. **`oob analyze`** — Composite market analysis for agent decision-making
4. **`oob wallet`** — Key management, balance checks, approval status
5. **`oob tx`** — Build and broadcast transactions
6. **`oob pipe`** — stdin/stdout pipeline mode for agent tool chaining

---

## 7. AI-Agent Design Principles

### 7.1 Core Principles

1. **Deterministic output** — Every command outputs parseable structured data (JSON/JSONL). No ambiguous human text in stdout.

2. **Composable** — Commands can be piped together. Output of one command is valid input for another.

3. **Atomic operations** — Each command does one thing. Complex workflows are composed by the agent.

4. **Explicit errors** — Errors go to stderr in structured format. Exit codes encode error category. Agents never need to parse error messages.

5. **Idempotent where possible** — Retrying a failed command should be safe. Duplicate order submissions return the existing order.

6. **Pre-flight checks** — Commands that require on-chain state (fill, approve) should validate pre-conditions and return clear failure reasons before attempting execution.

7. **Dry-run mode** — Write commands support `--dry-run` to preview what would happen without executing.

8. **Context-efficient output** — Support compact formats (TOON/JSONL) to minimize LLM context window usage.

9. **Self-describing** — `oob describe <command>` returns machine-readable schema of inputs/outputs for each command.

10. **Stateless by default** — No implicit state between commands. All context passed explicitly via flags or stdin.

### 7.2 Agent Interaction Patterns

```
# Pattern 1: Query → Decide → Execute
oob orders best-listing --collection 0x... --output json | agent_decide | oob orders fill --stdin

# Pattern 2: Monitor → React
oob stream --collection 0x... --events new_listing | agent_filter | oob orders fill --stdin

# Pattern 3: Analyze → Report
oob market snapshot --collection 0x... --output json | agent_analyze

# Pattern 4: Batch Execution
oob batch execute --file operations.jsonl

# Pattern 5: Pre-flight → Execute
oob orders fill --hash 0x... --dry-run && oob orders fill --hash 0x...
```

---

## 8. Feature Roadmap

### Phase 1 — Foundation (Agent-Ready Reads + Architecture)

**Goal**: Modular architecture, complete read coverage, agent-optimized output.

| Feature | Command | Description |
|---|---|---|
| **Modular commands** | — | Split monolithic index.ts into per-domain command files |
| **Activity query** | `oob activity list` | Query order activity/events |
| **Activity by order** | `oob activity order <hash>` | Activity for specific order |
| **Fill-tx read** | `oob orders fill-tx <hash>` | Get ready-to-sign fill calldata |
| **Best-listing fill-tx** | `oob orders floor-tx` | Get floor listing + fill calldata |
| **Protocol config** | `oob config protocol` | Show protocol fee config |
| **ERC20 approve-tx** | `oob approve-tx <token>` | Build ERC20 approval calldata |
| **TOON output** | `--output toon` | Compact LLM-friendly format |
| **Verbose mode** | `--verbose` | Debug logging to stderr |
| **Max lines** | `--max-lines <n>` | Truncate output |
| **Describe command** | `oob describe <command>` | Machine-readable command schema |
| **Programmatic export** | `import { OobCLI } from '@oob/cli'` | Use CLI as library |

### Phase 2 — Execution (Agent Writes)

**Goal**: Wallet integration, full order lifecycle.

| Feature | Command | Description |
|---|---|---|
| **Wallet config** | `oob wallet set-key` | Configure private key (env var or keystore) |
| **Wallet info** | `oob wallet info` | Show address, ETH balance, chain |
| **Wallet balance** | `oob wallet balance` | ETH + ERC20 balances |
| **Create listing** | `oob orders create-listing` | Sign and submit a listing |
| **Create offer** | `oob orders create-offer` | Sign and submit an offer |
| **Fill order** | `oob orders fill <hash>` | Fill a specific order on-chain |
| **Cancel order** | `oob orders cancel <hash>` | Cancel an order on-chain + API |
| **Sweep floor** | `oob orders sweep` | Fill multiple cheapest listings |
| **Accept offer** | `oob orders accept-offer <hash>` | Accept an open collection offer |
| **Check approval** | `oob wallet check-approval` | Check NFT/ERC20 Seaport approval |
| **Approve NFT** | `oob wallet approve-nft` | Approve NFT collection for Seaport |
| **Approve ERC20** | `oob wallet approve-erc20` | Approve ERC20 for Seaport |
| **Dry-run** | `--dry-run` on all write commands | Preview without executing |
| **Gas estimation** | `--estimate-gas` | Show gas estimate before execution |
| **Batch execute** | `oob batch execute` | Execute multiple write operations |

### Phase 3 — Streaming & Monitoring (Agent Reactivity)

**Goal**: Real-time event consumption, persistent monitoring.

| Feature | Command | Description |
|---|---|---|
| **WebSocket stream** | `oob stream` | Subscribe to real-time events as JSONL |
| **Stream filters** | `--events`, `--collections` | Filter event types and collections |
| **Price alerts** | `oob watch price` | Alert when floor crosses threshold |
| **Order tracking** | `oob watch order <hash>` | Track specific order until terminal state |
| **Collection watch** | `oob watch collection` | Monitor new listings/offers/sales |
| **Portfolio watch** | `oob watch wallet <addr>` | Monitor wallet's order activity |

### Phase 4 — Intelligence & Composition (Agent Decision Support)

**Goal**: Higher-level analytical commands, agent tooling.

| Feature | Command | Description |
|---|---|---|
| **Market depth** | `oob analyze depth` | Full order book depth (bid/ask) |
| **Price history** | `oob analyze price-history` | Price trends from activity |
| **Spread analysis** | `oob analyze spread` | Bid-ask spread + liquidity metrics |
| **Arbitrage scan** | `oob analyze arb` | Cross-collection/cross-chain opportunities |
| **Portfolio value** | `oob analyze portfolio <addr>` | Holdings + floor value |
| **MCP server** | `oob mcp serve` | Model Context Protocol server for direct LLM tool use |
| **Agent manifest** | `oob agent manifest` | Export full capability manifest for agent frameworks |

### Phase 5 — Human UX Polish

**Goal**: Make the CLI accessible to non-technical users.

| Feature | Command | Description |
|---|---|---|
| **Interactive mode** | `oob interactive` | Guided prompts for all operations |
| **Setup wizard** | `oob setup` | First-time configuration wizard |
| **Pretty tables** | `--output table` | Beautiful table formatting |
| **ENS resolution** | automatic | Resolve ENS names to addresses |
| **Price formatting** | `--human-prices` | Show ETH/USD instead of wei |
| **Confirmation prompts** | default on write | `--yes` to skip for agents |
| **Shell completions** | `oob completions` | Bash/Zsh/Fish completions |

---

## 9. Architecture & Refactoring Plan

### 9.1 Current Structure (Monolithic)

```
packages/cli/src/
├── cli.ts          # Entry point (4 lines)
├── index.ts        # EVERYTHING (1374 lines)
├── errors.ts       # Error types (54 lines)
└── network.ts      # HTTP client (91 lines)
```

### 9.2 Target Structure (Modular)

```
packages/cli/src/
├── cli.ts                    # Entry point
├── index.ts                  # Public API exports (for programmatic use)
├── program.ts                # Commander program builder
├── config.ts                 # Config resolution (env, flags, defaults)
├── client.ts                 # API client wrapper
├── wallet.ts                 # Wallet management (private key, keystore)
├── errors.ts                 # Error types (existing, expanded)
├── network.ts                # HTTP client (existing)
├── output/
│   ├── index.ts              # Format dispatcher
│   ├── json.ts               # JSON formatter
│   ├── jsonl.ts              # JSONL formatter
│   ├── text.ts               # Human-readable text
│   ├── toon.ts               # TOON encoder (compact LLM format)
│   └── table.ts              # Table formatter
├── commands/
│   ├── index.ts              # Command barrel export
│   ├── config.ts             # config show, doctor, check
│   ├── orders.ts             # orders list, get, best-listing, best-offer
│   ├── execute.ts            # create-listing, create-offer, fill, cancel, sweep
│   ├── activity.ts           # activity list, by-order
│   ├── market.ts             # market snapshot, token-summary
│   ├── collections.ts        # collections stats
│   ├── batch.ts              # batch run, batch execute
│   ├── stream.ts             # WebSocket streaming
│   ├── wallet.ts             # wallet info, balance, approvals
│   ├── watch.ts              # watch price, order, collection
│   ├── analyze.ts            # analyze depth, spread, price-history
│   └── describe.ts           # describe command (machine-readable schema)
├── types.ts                  # Shared CLI types
└── utils/
    ├── parse.ts              # Argument parsing helpers
    ├── format.ts             # Price/address formatting
    └── stdin.ts              # Stdin reading helpers
```

### 9.3 Refactoring Strategy

1. **Extract config resolution** from `index.ts` → `config.ts`
2. **Extract API client** from `index.ts` → `client.ts`
3. **Extract output formatters** from `index.ts` → `output/`
4. **Extract each command group** from `index.ts` → `commands/`
5. **Add public exports** in `index.ts` for programmatic SDK use
6. **Keep backward compatibility** — all existing commands and flags continue to work
7. **Incremental** — each step is a standalone PR that doesn't break existing functionality

---

## 10. API & Backend Modifications

### 10.1 New Endpoints Needed

| Endpoint | Purpose | Priority |
|---|---|---|
| `GET /v1/activity` | Query activity across all orders (with filters) | P1 |
| `GET /v1/activity?collection=0x...` | Activity for a collection | P1 |
| `GET /v1/orders/depth` | Full order book depth (aggregated price levels) | P2 |
| `GET /v1/collections/:addr/orders-summary` | Richer collection summary (listing count by price range, offer distribution) | P2 |

### 10.2 Existing Endpoint Enhancements

| Endpoint | Enhancement | Priority |
|---|---|---|
| `GET /v1/orders` | Add `cursor`-based pagination alongside `offset` (for streaming) | P2 |
| `GET /v1/orders` | Add `since` timestamp filter for incremental fetches | P2 |
| `GET /v1/orders/best-listing` | Add `limit` param to return top N listings (not just 1) | P2 |
| `GET /v1/orders/best-offer` | Add `limit` param to return top N offers (not just 1) | P2 |
| `GET /v1/collections/:addr/stats` | Add `updatedSince` for conditional fetching | P3 |

### 10.3 Activity Endpoint Design

Currently, activity is only queryable per-order (`GET /v1/orders/:hash/activity`). Agents need a global activity feed.

```
GET /v1/activity?chainId=8453&collection=0x...&eventType=filled&limit=50&since=1707840000
```

Response:
```json
{
  "activity": [
    {
      "eventType": "filled",
      "orderHash": "0x...",
      "chainId": 8453,
      "nftContract": "0x...",
      "tokenId": "42",
      "fromAddress": "0x...",
      "toAddress": "0x...",
      "priceWei": "1000000000000000000",
      "currency": "0x000...000",
      "txHash": "0x...",
      "createdAt": "2025-02-13T15:00:00.000Z"
    }
  ],
  "total": 50
}
```

This is straightforward — the `order_activity` table already exists, just needs a route + query handler.

---

## 11. SDK Modifications

### 11.1 Changes for CLI Integration

The SDK already has comprehensive functionality. The CLI needs:

1. **Wallet from private key** — Add a helper to create `WalletClient` + `PublicClient` from a private key string and RPC URL, wrapping `viem`'s `createWalletClient` / `createPublicClient`.

2. **RPC URL management** — The SDK currently requires the caller to provide `WalletClient` + `PublicClient`. For CLI use, we need a simple `connect({ privateKey, rpcUrl, chainId })` that does all the wiring.

3. **Activity query** — Add `getActivity()` method when the API endpoint is added.

4. **Order depth** — Add `getOrderDepth()` method when the API endpoint is added.

### 11.2 New SDK Exports for CLI

```typescript
// New convenience for CLI/agent use
export function createOobFromPrivateKey(config: {
  privateKey: `0x${string}`;
  rpcUrl: string;
  chainId: number;
  apiUrl?: string;
}): OpenOrderBook;
```

---

## 12. Output Formats for Agents

### 12.1 Format Comparison

| Format | Tokens (est.) | Parse Speed | Agent Friendliness | When to Use |
|---|---|---|---|---|
| **JSON** | 1x (baseline) | Fast | High | Default, most compatible |
| **JSONL** | ~0.9x | Fastest | High | Streaming, piping |
| **TOON** | ~0.6x | Medium | High | LLM context optimization |
| **Text** | ~0.7x | Slow | Low | Human reading |
| **Table** | ~0.5x | Slow | Low | Human reading |

### 12.2 TOON Implementation

TOON (Token-Oriented Object Notation) uses ~40% fewer tokens than JSON by:
- Collapsing uniform arrays into CSV-like tables with a single header
- Using YAML-like `key: value` for objects
- Eliminating quotes on safe strings
- Eliminating braces and brackets

Example — orders list in JSON (~180 tokens):
```json
{
  "orders": [
    {"orderHash": "0xabc", "priceWei": "1000000000000000000", "status": "active"},
    {"orderHash": "0xdef", "priceWei": "2000000000000000000", "status": "active"}
  ],
  "total": 2
}
```

Same data in TOON (~110 tokens):
```
orders[2]{orderHash,priceWei,status}:
  0xabc,1000000000000000000,active
  0xdef,2000000000000000000,active
total: 2
```

We will implement our own TOON encoder (not copy competitor code) following the [TOON v3.0 spec](https://github.com/toon-format/spec/blob/main/SPEC.md).

### 12.3 `--field` Enhancements

Current `--field` extracts a single nested path. Enhancements:

- **Multiple fields**: `--field orderHash,priceWei,status`
- **Array mapping**: `--field orders[].priceWei` → extract field from each array element
- **Computed fields**: `--field "priceEth=priceWei/1e18"` (future)

---

## 13. Human UX Layer (Phase 2)

After the agent-first implementation is complete, add human-friendly features:

### 13.1 Interactive Mode

```
$ oob interactive
OOB > list --collection 0x... --type listing
┌─────────────┬──────────────────────┬────────┐
│ Order Hash  │ Price (ETH)          │ Status │
├─────────────┼──────────────────────┼────────┤
│ 0xabc...    │ 1.0                  │ active │
│ 0xdef...    │ 1.5                  │ active │
└─────────────┴──────────────────────┴────────┘
OOB > fill 0xabc...
⚠ This will spend 1.0 ETH + gas. Continue? [y/N]
```

### 13.2 Human-Friendly Output

- Format prices as ETH/WETH with USD equivalent
- Shorten addresses: `0x1234...abcd`
- Relative timestamps: "2 hours ago"
- Color-coded statuses
- Progress spinners for on-chain transactions

### 13.3 Setup Wizard

```
$ oob setup
Welcome to Open Order Book CLI!

1. Network: [Base (8453)] / Ethereum (1) / Other
2. RPC URL: [Enter your RPC URL or press Enter for public default]
3. Private Key: [Paste your private key or press Enter to skip]
4. API Key: [Paste your API key or press Enter for public access]

✓ Configuration saved to ~/.oob/config.json
✓ Connected to Base (chain 8453)
✓ Wallet: 0x1234...abcd (0.5 ETH)
```

---

## 14. Testing Strategy

### 14.1 Unit Tests

- **Output formatters**: Snapshot tests for JSON, JSONL, TOON, text for every data shape
- **Config resolution**: All env var / flag / default combinations
- **Argument parsing**: Edge cases for addresses, numbers, hashes
- **Error classification**: All error types produce correct exit codes

### 14.2 Integration Tests

- **API interaction**: Mock server tests for all read commands
- **Wallet operations**: Local Hardhat/Anvil fork tests for write commands
- **WebSocket**: Mock WS server tests for streaming
- **Batch operations**: Multi-request test scenarios

### 14.3 E2E Tests

- **Full lifecycle**: Create listing → fill order → verify filled status
- **Agent simulation**: Script that simulates an agent making decisions and executing trades
- **Error recovery**: Network failures, rate limits, insufficient balance

---

## 15. Implementation Phases

### Phase 1: Foundation (Weeks 1–3) — ✅ COMPLETED

**Architecture refactor + complete read coverage + agent output**

1. ✅ Refactor monolithic `index.ts` into modular command files
2. ✅ Add `activity list` and `activity order <hash>` commands
3. ✅ Add `orders fill-tx <hash>` command
4. ✅ Add `orders floor-tx` (best-listing + fill-tx combined) command
5. ✅ Add `config protocol` command
6. ✅ Add `approve-tx <token>` command
7. ✅ Implement TOON output format (`--output toon` / `--toon`)
8. ✅ Add `--verbose` debug mode
9. ✅ Add `--max-lines` truncation
10. ✅ Add `oob describe <command>` for machine-readable schemas
11. ✅ Export programmatic API from package
12. ✅ Unit tests for all new functionality (24 tests, all passing)

**Deliverable**: A CLI that exposes every OOB read operation with optimized agent output.

#### Phase 1 Implementation Notes & Key Decisions

**Architecture** (completed):
- Split monolithic `src/index.ts` (1374 lines) into 13 modular files:
  - `src/config.ts` — Config resolution, parsing, global options, env var handling
  - `src/client.ts` — `CliApiClient` class wrapping all API endpoints
  - `src/types.ts` — All shared TypeScript types (OutputFormat, order types, runtime config, etc.)
  - `src/utils.ts` — Normalization helpers for addresses, params, strings
  - `src/runtime.ts` — `withConfig()` action wrapper, argv normalization, action promise tracking
  - `src/output/index.ts` — Output rendering (JSON, JSONL, text, TOON), field selection, error emission
  - `src/output/toon.ts` — TOON format encoder (compact LLM-friendly output)
  - `src/commands/config.ts` — config show/doctor/check/protocol commands
  - `src/commands/orders.ts` — orders list/get/best-listing/best-offer/fill-tx/floor-tx commands
  - `src/commands/collections.ts` — collections stats command
  - `src/commands/market.ts` — market snapshot/token-summary commands
  - `src/commands/activity.ts` — activity list/order commands
  - `src/commands/batch.ts` — batch run command
  - `src/commands/approve.ts` — approve-tx command
  - `src/commands/describe.ts` — describe command with full schema registry
  - `src/commands/index.ts` — barrel export for all command registrations
- `src/index.ts` is now a clean public API surface (re-exports + `buildProgram()` + `runCli()`)

**Key decision — fill-tx requires `--buyer`** (mid-risk, matches API):
- The API's `/v1/orders/:hash/fill-tx` and `/v1/orders/best-listing/fill-tx` both require a `buyer` query param.
- CLI exposes this as `--buyer <address>` (required option on `fill-tx` and `floor-tx`).
- Optional `--validate`, `--tip-recipient`, `--tip-bps` also supported.
- Batch `orders.fill-tx` and `orders.floor-tx` require `buyer` in args object.

**Key decision — activity list uses `/v1/activity` endpoint**:
- `activity order <hash>` uses `/v1/orders/:hash/activity` (convenience route).
- `activity list` uses `/v1/activity` with full query params: `--collection`, `--token-id`, `--event-type`, `--address`, `--order-hash`, `--limit`, `--offset`.
- Activity response includes enriched fields: `priceDecimal`, `currencySymbol`, `toAddress`.

**Key decision — TOON format implemented from scratch**:
- Custom TOON encoder in `src/output/toon.ts` (~120 lines).
- Supports primitives, nested objects, arrays, uniform object arrays (tabular format).
- Null rendered as `-`, strings auto-quoted only when ambiguous.
- Uniform arrays rendered as compact `[N]{col1,col2}: row1 row2` format.
- Estimated ~40% token savings vs JSON for typical API responses.

**Key decision — describe command schema registry**:
- Static `COMMAND_SCHEMAS` map with 15 command schemas.
- Each schema includes: name, description, arguments, options (with flags + required), outputFields.
- `oob describe` (no arg) lists all commands. `oob describe orders-fill-tx` returns full schema.
- Designed for AI agent tool discovery — agents can introspect capabilities without parsing help text.

**Key decision — programmatic API exports**:
- `@oob/cli` package now exports: `buildProgram`, `runCli`, `CliApiClient`, `createClient`, `resolveConfig`, `formatToon`, `renderSuccess`, `emitError`, `CliError`, `classifyError`, `withConfig`, and all types.
- Enables use as a library (e.g., from agent frameworks, MCP servers, custom scripts).

**Backward compatibility**: All 6 original e2e tests continue to pass unchanged. New tests: 18 additional tests covering TOON output, describe, activity, fill-tx, floor-tx, approve-tx, verbose, max-lines, batch fill-tx, and programmatic exports.

### Phase 2: Execution (Weeks 4–6) — ✅ COMPLETED

**Wallet integration + full write commands**

1. ✅ Implement wallet management (`OOB_PRIVATE_KEY` env var, `--private-key` flag)
2. ✅ Add RPC URL configuration (`OOB_RPC_URL` env var, `--rpc-url` flag)
3. ✅ Create `wallet info`, `wallet balance`, `wallet check-approval` commands
4. ✅ Implement `orders create-listing` command
5. ✅ Implement `orders create-offer` command
6. ✅ Implement `orders fill <hash>` command
7. ✅ Implement `orders cancel <hash>` command
8. ✅ Implement `orders sweep` (batch fill cheapest N listings) command
9. ✅ Implement `orders accept-offer <hash>` command
10. ✅ Add `--dry-run` to all write commands
11. ✅ Add `wallet approve-nft`, `wallet approve-erc20` commands
12. ✅ Implement `batch execute` for write operations
13. ⬚ Integration tests with Anvil fork (deferred — requires local Anvil setup)

**Deliverable**: Agents can autonomously execute the full order lifecycle.

#### Phase 2 Implementation Notes & Key Decisions

**New files created**:
- `src/wallet.ts` — Wallet context creation with lazy dynamic imports for viem and @oob/sdk
- `src/commands/wallet.ts` — wallet info/balance/check-approval/approve-nft/approve-erc20 commands
- `src/commands/orders-write.ts` — orders create-listing/create-offer/fill/cancel/sweep/accept-offer commands

**Modified files**:
- `src/types.ts` — Added `privateKey`, `rpcUrl`, `dryRun` to `RuntimeConfig` and `CommandOptions`
- `src/config.ts` — Added `--private-key`, `--rpc-url`, `--dry-run` global options with env var fallbacks
- `src/runtime.ts` — Updated argv normalizer for wallet/write subcommands, added `--private-key`/`--rpc-url` to option names
- `src/commands/batch.ts` — Added `batch execute` for write operations (orders.create-listing, orders.create-offer, orders.fill, orders.cancel, wallet.approve-nft, wallet.approve-erc20)
- `src/commands/describe.ts` — Added 12 new command schemas for all Phase 2 commands
- `src/commands/index.ts` — Exports `registerWalletCommands` and `registerWriteOrderCommands`
- `src/index.ts` — Registers wallet and write order commands, exports wallet utilities
- `tsup.config.ts` — Added `external: ["@oob/sdk", "viem", ...]` to prevent bundling
- `package.json` — Added `@oob/sdk` and `viem` dependencies

**Key decision — lazy dynamic imports for viem/@oob/sdk**:
- The SDK's `seaport.ts` calls `parseAbi()` at module load time, which triggers an abitype parser crash on deeply nested Seaport ABI tuples.
- All `import("viem")` and `import("@oob/sdk")` are done via async dynamic imports inside function bodies, not at module top level.
- This means read-only commands never load viem or the SDK — zero impact on Phase 1 commands.
- Private key validation (`requirePrivateKey`) runs before dynamic imports so users get clean error messages.

**Key decision — `--dry-run` bypasses wallet requirement**:
- All write commands check `config.dryRun` before calling `createWalletContext`.
- Dry-run for create-listing/create-offer returns parsed price, collection, tokenId without signing.
- Dry-run for fill/cancel/accept-offer fetches order info from API to show what would happen.
- Dry-run for sweep fetches cheapest listings and shows total cost breakdown.
- Dry-run for approve-nft/approve-erc20 returns action description without on-chain tx.

**Key decision — sweep command architecture**:
- Fetches cheapest active listings via `orders.list` (sorted `price_asc`, limited to `--count`).
- Optional `--max-price` filters out listings above threshold.
- Fills orders sequentially (not batched) with per-order error handling.
- Reports filled/failed counts and individual results.

**Key decision — batch execute**:
- `batch execute` accepts same JSONL/JSON format as `batch run` but routes to write operations.
- Supported commands: `orders.create-listing`, `orders.create-offer`, `orders.fill`, `orders.cancel`, `wallet.approve-nft`, `wallet.approve-erc20`.
- Creates wallet context once and reuses for all operations in the batch.
- Supports `--dry-run` to preview all operations without executing.

**Key decision — tsup externals**:
- `@oob/sdk`, `viem`, `viem/accounts`, `viem/chains` marked as external in tsup config.
- These are resolved from `node_modules` at runtime instead of being bundled.
- Prevents abitype parse errors during bundle evaluation and keeps bundle size small (~102KB).

**Tests**: 41 total (24 Phase 1 + 17 Phase 2), all passing. Phase 2 tests cover:
- Config resolution with `--private-key`, `--dry-run`
- Describe lists all Phase 2 commands (12 new schemas, 27 total)
- Describe returns correct schemas for new commands
- Write commands fail with clean error when no private key provided
- `--dry-run` previews for: create-listing, create-offer, fill, cancel, sweep, approve-nft, approve-erc20
- Programmatic exports include wallet utilities

### Phase 3: Streaming & Monitoring (Weeks 7–8) — ✅ COMPLETED

**Real-time events + persistent watching**

1. ✅ Implement `stream` command (WebSocket → JSONL to stdout)
2. ✅ Add stream filters (`--events`, `--collections`, `--chain-ids`)
3. ✅ Implement `watch price` (alert on floor price crossing threshold)
4. ✅ Implement `watch order <hash>` (track until terminal state)
5. ✅ Implement `watch collection` (monitor new listings/offers/sales)
6. ✅ Add reconnection logic with exponential backoff for WebSocket

**Deliverable**: Agents can react to real-time market events.

#### Phase 3 Implementation Notes & Key Decisions

**New files created**:
- `src/commands/stream.ts` — WebSocket streaming with auto-reconnect, keep-alive pings, server-side filters
- `src/commands/watch.ts` — Poll-based watch order (until terminal), watch price (threshold alerts), watch collection (activity watermark)

**Key decision — WebSocket with ws fallback**:
- Uses native `globalThis.WebSocket` (Node 22+) with fallback to `ws` package for older Node versions.
- Exponential backoff reconnection (1s → 30s max).
- Keep-alive pings every 30s to prevent idle disconnects.
- Filters passed as query parameters matching API's `OrderStreamDO` Durable Object interface.

**Key decision — watch price threshold parsing**:
- Accepts both ETH (e.g. `1.5`) and wei (large integers) in `--below`/`--above`.
- Converts ETH to wei internally for comparison against `floorPriceWei`.

**Key decision — watch collection watermark**:
- Tracks `lastSeenId` from activity events to only emit new events.
- First iteration sets watermark from existing events (no initial flood).
- Optional `--events` filter for specific event types.

### Phase 4: Intelligence (Weeks 9–10) — ✅ COMPLETED

**Analysis commands + agent framework integration**

1. ✅ Implement `analyze depth` command (bid/ask price distribution with configurable buckets)
2. ✅ Implement `analyze spread` command (bid-ask spread in wei and bps)
3. ✅ Implement `analyze price-history` command (price trends from sales activity)
4. ✅ Implement `analyze portfolio <address>` command (active orders grouped by collection)
5. ✅ Implement `agent manifest` (capability export for agent frameworks)
6. ✅ Implement MCP (Model Context Protocol) server mode (`oob mcp serve`)

**Deliverable**: Agents have rich analytical data and can integrate via standard protocols.

#### Phase 4 Implementation Notes & Key Decisions

**New files created**:
- `src/commands/analyze.ts` — analyze depth (bucketed order book), spread (bid-ask metrics), price-history (trend from sales), portfolio (positions by wallet)
- `src/commands/agent.ts` — agent manifest (full capability JSON), MCP server over stdio

**Key decision — analyze depth buckets**:
- Fetches up to 100 listings (price_asc) and 100 offers (price_desc).
- Divides price range into N buckets (default 10) with order counts per bucket.
- Both listing (ask) and offer (bid) sides shown separately.

**Key decision — analyze spread**:
- Parallel fetches: best-listing, best-offer, collection stats.
- Spread computed in both wei and basis points (bps).

**Key decision — MCP server**:
- Dynamic import of `@modelcontextprotocol/sdk` — only loaded when `mcp serve` is invoked.
- Registers 9 tools covering read operations (orders, collections, activity, market, spread).
- Uses stdio transport for direct integration with LLM frameworks.

**Key decision — agent manifest**:
- Static capability manifest covering all CLI commands organized by category (read, write, monitoring, analysis, batch, meta).
- Includes all output formats and global flags.
- Designed for agent framework discovery (LangChain, AutoGPT, etc.).

### Phase 5: Human Polish (Weeks 11–12) — ✅ COMPLETED

**Interactive mode + human-friendly features**

1. ✅ Implement `setup` wizard (interactive first-time config, saves to `~/.oob/env`)
2. ✅ Add `--output table` pretty table formatting (aligned columns for arrays, key-value for objects)
3. ✅ Add human-friendly price formatting flag (`--human-prices`)
4. ✅ Add `--yes` flag for skipping confirmation prompts in write operations
5. ✅ Add shell completions (`oob completions bash|zsh|fish`)
6. ⬚ Implement `interactive` mode with prompts (deferred — lower priority)
7. ✅ Comprehensive documentation update

**Deliverable**: Non-technical users can use the CLI with full functionality.

#### Phase 5 Implementation Notes & Key Decisions

**New files created**:
- `src/output/table.ts` — Table formatter: arrays → aligned columns with separator, objects → padded key-value pairs, truncation at 60 chars
- `src/commands/setup.ts` — Interactive wizard using `readline/promises`, saves config to `~/.oob/env`
- `src/commands/completions.ts` — Generates bash, zsh, and fish completion scripts with full command/subcommand/flag coverage
- `src/mcp-shims.d.ts` — Type declarations for dynamically imported modules (ws, @modelcontextprotocol/sdk)

**Modified files**:
- `src/types.ts` — Added `table` to `OutputFormat`, added `humanPrices` and `yes` to `RuntimeConfig` and `CommandOptions`
- `src/config.ts` — Added `--table`, `--human-prices`, `--yes` global options, `table` to output format parser
- `src/output/index.ts` — Added table output rendering path before JSON
- `src/runtime.ts` — Added argv normalizer rules for watch, analyze, agent, mcp subcommands
- `src/commands/config.ts` — Config show now outputs `humanPrices`, `yes`, `dryRun` fields
- `src/commands/describe.ts` — Added 12 new command schemas (stream, watch-order/price/collection, analyze-depth/spread/price-history/portfolio, agent-manifest, mcp-serve, setup, completions)
- `src/commands/index.ts` — Exports all 6 new command registrations
- `src/index.ts` — Registers all new commands, exports `formatTable`
- `tsup.config.ts` — Added `ws`, `@modelcontextprotocol/sdk` to externals
- `package.json` — Added `ws` and `@modelcontextprotocol/sdk` dependencies

**Tests**: 59 total (41 Phase 1-2 + 18 Phase 3-5), all passing. Phase 3-5 tests cover:
- Describe lists all 39+ commands (12 new Phase 3-5 schemas)
- Describe returns correct schemas for stream, watch-order, analyze-depth, agent-manifest, completions
- Analyze spread/depth/price-history/portfolio return structured data
- Agent manifest returns capabilities, output formats, global flags
- `--table` flag produces non-JSON aligned column output
- `--output table` equivalent to `--table`
- Config show includes `humanPrices` and `yes` fields
- Shell completions generate valid bash/zsh/fish scripts
- `formatTable` programmatic export accessible

---

## Appendix A: Wallet Security Model

For agent use, private keys need to be accessible but secure:

| Method | Security | Agent Compatibility | Priority |
|---|---|---|---|
| `OOB_PRIVATE_KEY` env var | Medium | ✅ Best for agents | P0 |
| `--private-key` flag | Low (visible in process list) | ✅ Works | P0 |
| `~/.oob/keystore` encrypted file | High | ⚠ Needs password | P2 |
| Hardware wallet (Ledger/Trezor) | Highest | ❌ Requires interaction | P3 |

**Recommendation**: Start with env var + flag. Add keystore later. Document security best practices.

**Safety features**:
- `--dry-run` on all write commands (default for first run)
- `--max-value <wei>` to cap maximum spend per transaction
- `--confirm` / `--yes` flags for human vs agent mode
- All transaction hashes logged to stderr

## Appendix B: Environment Variables

| Variable | Description | Default |
|---|---|---|
| `OOB_API_URL` | API base URL | `https://api.openorderbook.xyz` |
| `OOB_CHAIN_ID` | Default chain ID | `8453` (Base) |
| `OOB_API_KEY` | API key for higher rate limits | (none) |
| `OOB_PRIVATE_KEY` | Wallet private key for write operations | (none) |
| `OOB_RPC_URL` | RPC endpoint for on-chain operations | (public default per chain) |
| `OOB_OUTPUT` | Default output format | `json` |
| `OOB_ENV` | Environment label | `production` |
| `OOB_VERBOSE` | Enable verbose logging | `false` |
| `OOB_MAX_RETRIES` | Max retry attempts | `3` |
| `OOB_TIMEOUT_MS` | Request timeout | `30000` |

## Appendix C: Exit Code Reference

| Code | Name | Description |
|---|---|---|
| 0 | `SUCCESS` | Command completed successfully |
| 1 | `API_ERROR` | API returned an error response |
| 2 | `AUTH_ERROR` | Authentication/authorization failure |
| 3 | `NETWORK_ERROR` | Network connectivity or timeout |
| 4 | `INVALID_INPUT` | Invalid arguments or options |
| 5 | `BATCH_PARTIAL` | Batch operation partially failed |
| 6 | `TX_FAILED` | On-chain transaction failed |
| 7 | `INSUFFICIENT_FUNDS` | Not enough ETH/ERC20 balance |
| 8 | `APPROVAL_NEEDED` | NFT/ERC20 approval required |
| 9 | `ORDER_EXPIRED` | Order is no longer active |

## Appendix D: Command Quick Reference

```bash
# === READS ===
oob orders list --collection 0x... --type listing --sort-by price_asc
oob orders get <hash>
oob orders best-listing --collection 0x... [--token-id 42]
oob orders best-offer --collection 0x... [--token-id 42]
oob orders fill-tx <hash>
oob orders floor-tx --collection 0x...
oob activity list --collection 0x... --event-type filled
oob activity order <hash>
oob collections stats <address>
oob market snapshot --collection 0x...
oob market token-summary --collection 0x... --token-id 42
oob config show
oob config doctor
oob config check
oob config protocol

# === WRITES ===
oob orders create-listing --collection 0x... --token-id 42 --price 1.5
oob orders create-offer --collection 0x... --price 0.5 [--token-id 42]
oob orders fill <hash> [--tip-bps 100 --tip-recipient 0x...]
oob orders cancel <hash>
oob orders sweep --collection 0x... --count 5 --max-price 2.0
oob orders accept-offer <hash>

# === WALLET ===
oob wallet info
oob wallet balance [--token 0x...]
oob wallet check-approval --collection 0x...
oob wallet approve-nft --collection 0x...
oob wallet approve-erc20 --token 0x...

# === STREAMING ===
oob stream --collection 0x... --events new_listing,sale
oob watch price --collection 0x... --below 1.0
oob watch order <hash>

# === ANALYSIS ===
oob analyze depth --collection 0x...
oob analyze spread --collection 0x...
oob analyze price-history --collection 0x... --days 7

# === BATCH ===
oob batch run --file requests.jsonl
oob batch execute --file operations.jsonl

# === AGENT TOOLING ===
oob describe orders-fill         # Machine-readable command schema
oob agent manifest               # Full capability manifest
oob mcp serve                    # Start MCP server

# === GLOBAL FLAGS ===
--chain-id <n>        --api-url <url>       --api-key <key>
--output json|jsonl|toon|text|table
--field <path>        --raw                 --watch
--interval <s>        --timeout <ms>        --retries <n>
--verbose             --max-lines <n>       --dry-run
--private-key <key>   --rpc-url <url>       --yes
```

---

*This document is a living plan. Update it as implementation progresses and new requirements emerge.*
