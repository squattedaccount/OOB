# @oob/indexer

Standalone Cloudflare Worker that monitors Seaport v1.6 on-chain events and manages order lifecycle in the OOB database.

## What It Does

1. **Webhook receiver** — accepts on-chain log events from Alchemy, Moralis, or Goldsky
2. **Order lifecycle** — updates `seaport_orders` status when orders are filled, cancelled, or bulk-cancelled on-chain
3. **Expiry cron** — marks orders past their `end_time` as expired (every 5 min)
4. **Stale detection** — checks NFT ownership via RPC and marks transferred-away listings as stale

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
wrangler secret put RPC_URL_BASE      # Alchemy/Infura RPC for Base
wrangler secret put RPC_URL_ETHEREUM  # Alchemy/Infura RPC for Ethereum
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
