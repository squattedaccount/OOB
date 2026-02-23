# @oob/indexer

Standalone Cloudflare Worker that monitors Seaport v1.6 on-chain events and manages order lifecycle in the OOB database.

## What It Does

1. **Webhook receiver** — accepts on-chain log events from Alchemy, Moralis, or Goldsky
2. **Order lifecycle** — updates `seaport_orders` status when orders are filled, cancelled, or bulk-cancelled on-chain
3. **Expiry cron** — marks orders past their `end_time` as expired (every 5 min)
4. **Transfer stale detection (realtime)** — decodes ERC-721 `Transfer` logs and marks matching active listings as stale
5. **Ownership stale backstop (cron)** — round-robin owner checks using one Multicall3 call per chain when supported
6. **Goldsky pipeline sync** — auto-generates/applies transfer pipelines from active collections

## Seaport Events Monitored

| Event | Topic0 Hash | Action |
|-------|-------------|--------|
| `OrderFulfilled` | `0x9d9af8...` | Mark order `filled`, record tx hash |
| `OrderCancelled` | `0x6bacc0...` | Mark order `cancelled`, record tx hash |
| `CounterIncremented` | `0x721c20...` | Bulk-cancel all active orders for offerer on chain |

## Setup

```bash
cd packages/indexer
npm install

# Set secrets
wrangler secret put DATABASE_URL      # Same Neon DB as oob-api
wrangler secret put WEBHOOK_SECRET    # Shared secret for webhook verification
wrangler secret put RPC_URL_BASE      # Base (8453)
wrangler secret put RPC_URL_ETHEREUM  # Ethereum (1)
wrangler secret put RPC_URL_BASE_SEPOLIA # Base Sepolia (84532)
wrangler secret put RPC_URL_ABSTRACT  # Abstract (2741)
# ... add more chains as needed

# Deploy
wrangler deploy
```

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/webhook` | Generic webhook (auto-detects provider format) |
| `POST` | `/webhook/alchemy` | Alchemy Notify webhook |
| `POST` | `/webhook/moralis` | Moralis Streams webhook |
| `POST` | `/webhook/goldsky` | Goldsky Mirror webhook |
| `GET` | `/health` | Health check |
| `GET` | `/status` | Order counts by status |

## Goldsky Pipeline Sync

Use these scripts to keep Goldsky transfer pipelines aligned with active collections:

```bash
# One-shot sync (apply changes)
npm run sync-goldsky

# Preview generated YAML only
npm run sync-goldsky:dry

# Near-realtime watcher with debounced sync
npm run sync-goldsky:watch
```

Useful flags for `scripts/sync-goldsky-pipelines.ts`:

- `--list` show current Goldsky pipelines
- `--dry-run` print YAML without applying
- `--state-file <path>` skip apply when collection set is unchanged
- `--force` ignore state-file short-circuit
- `--strict` fail if any unsupported chains are skipped

## Architecture

```
On-chain events (Seaport v1.6)
        │
        ▼
┌─────────────────────┐
│  Webhook Provider    │  (Alchemy / Moralis / Goldsky)
│  monitors Seaport    │
│  contract events     │
└────────┬────────────┘
         │ POST /webhook
         ▼
┌─────────────────────┐
│  OOB Indexer Worker  │  ← this package
│                      │
│  • Decode events     │
│  • Update DB status  │
│  • Cron: expire +    │
│    stale detection   │
└────────┬────────────┘
         │
         ▼
┌─────────────────────┐
│  Neon Postgres       │  (shared with oob-api)
│  seaport_orders      │
└─────────────────────┘
```
