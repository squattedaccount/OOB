# OOB API

Public REST API for the [Open Order Book](https://github.com/openorderbook/sdk). Runs as a Cloudflare Worker.

If you are new to the project, start with [../../docs/start-here.md](../../docs/start-here.md). This document focuses on API worker setup, configuration, deployment, and subscription/access behavior.

## Endpoints

| Method | Path | Description |
|---|---|---|
| GET | `/v1/orders` | Query orders with filters |
| GET | `/v1/orders/:hash/activity` | Activity timeline for an order |
| GET | `/v1/orders/:hash` | Get single order by hash |
| GET | `/v1/orders/:hash/fill-tx` | Build fill transaction calldata for one order |
| GET | `/v1/orders/best-listing` | Cheapest active listing |
| GET | `/v1/orders/best-listing/fill-tx` | Build floor-snipe fill calldata |
| GET | `/v1/orders/best-offer` | Highest active offer |
| POST | `/v1/orders` | Submit a signed Seaport order |
| POST | `/v1/orders/batch` | Batch submit up to 20 orders |
| POST | `/v1/orders/batch/fill-tx` | Build sweep fill calldata for up to 20 orders |
| DELETE | `/v1/orders/:hash` | Cancel an order |
| DELETE | `/v1/orders/batch` | Batch cancel up to 20 orders |
| GET | `/v1/collections/:addr/stats` | Collection statistics |
| GET | `/v1/erc20/:token/approve-tx` | ERC20 approve calldata for Seaport |
| GET | `/v1/config` | Protocol fee config |
| WSS | `/v1/stream` | Real-time event stream |
| GET | `/health` | Health check |

See the full [API Reference](../../docs/api-reference.md) for endpoint details and [../../docs/architecture.md](../../docs/architecture.md) for the system-level architecture.

## Setup

### Prerequisites

- Node.js 18+
- Cloudflare account
- Neon Postgres database
- `wrangler` CLI

### Install

```bash
npm install
```

### Configure

```bash
# Set the database connection string
wrangler secret put DATABASE_URL

# Optional pooled Neon connection string for request traffic
wrangler secret put POOL_DATABASE_URL

# Protocol fee enforcement (required)
wrangler secret put PROTOCOL_FEE_RECIPIENT

# Session signing secret for dashboard/auth routes
wrangler secret put SESSION_SECRET

# Subscription payment configuration (USDC on Base)
wrangler secret put SUBSCRIPTION_TREASURY_ADDRESS
wrangler secret put SUBSCRIPTION_PAYMENT_TOKEN_ADDRESS
wrangler secret put SUBSCRIPTION_PAYMENT_CHAIN_ID
wrangler secret put SUBSCRIPTION_MIN_CONFIRMATIONS

# Base RPC for onchain payment verification
wrangler secret put RPC_URL_BASE
```

Copy `wrangler.toml.example` to your own local config as needed, and ensure all KV / Durable Object bindings exist before deployment.

### Run database migrations

```bash
DATABASE_URL=postgres://... npm run migrate
```

### Development

```bash
npm run dev
```

### Deploy

```bash
npm run deploy
```

### Production deployment order

1. Configure secrets and Wrangler bindings.
2. Run database migrations.
3. Deploy the API worker.
4. Confirm `/health` and one authenticated subscription flow work as expected.

## Environment Variables

| Variable | Type | Required | Description |
|---|---|---|---|
| `DATABASE_URL` | secret | **yes** | Neon Postgres connection string |
| `POOL_DATABASE_URL` | secret | no | Neon pooled connection string for request traffic |
| `SESSION_SECRET` | secret | **yes** for `/v1/auth` and authenticated subscription routes | HMAC secret for API dashboard sessions |
| `PROTOCOL_FEE_RECIPIENT` | secret | **yes** | Fee recipient enforced during order submission |
| `PROTOCOL_FEE_BPS` | var | no | Protocol fee bps (default: 33) |
| `API_KEYS` | secret/var | no | Comma-separated API keys for registered tier |
| `SUBSCRIPTION_TREASURY_ADDRESS` | secret | **yes** for paid subscriptions | Treasury address that receives subscription payments |
| `SUBSCRIPTION_PAYMENT_TOKEN_ADDRESS` | secret | **yes** for paid subscriptions | Accepted ERC20 token address for subscription payments |
| `SUBSCRIPTION_PAYMENT_CHAIN_ID` | var/secret | **yes** for paid subscriptions | Chain ID used for payment verification (currently Base mainnet) |
| `SUBSCRIPTION_MIN_CONFIRMATIONS` | var/secret | no | Minimum confirmations required before activating a payment (default: 1) |
| `RATE_LIMIT_PUBLIC_READS` | var | no | Public read limit per minute (default: 60) |
| `RATE_LIMIT_PUBLIC_WRITES` | var | no | Public write limit per minute (default: 10) |
| `RATE_LIMIT_REGISTERED_READS` | var | no | Registered read limit per minute (default: 300) |
| `RATE_LIMIT_REGISTERED_WRITES` | var | no | Registered write limit per minute (default: 60) |
| `DO_SHARD_COUNT` | var | no | WebSocket shard count per room (default: 1) |
| `INTERNAL_SECRET` | secret | no | Internal auth for DO broadcasts |
| `OOB_RATE_LIMIT` | KV binding | no | KV namespace for distributed rate limiting |
| `ORDER_STREAM` | DO binding | no | Durable Object namespace for WebSocket streams |
| `RPC_URL_BASE` | secret | **yes** for paid subscriptions on Base | RPC endpoint used to verify ERC20 transfer receipts |

## Subscription Rollout Notes

- **[payment chain]** Paid subscriptions currently verify an ERC20 transfer on Base using the configured token address and treasury recipient.
- **[quote lifetime]** Payment quotes are short-lived and remain usable only while they are still `open` and unexpired.
- **[idempotent verification]** Re-submitting the same `txHash` or an already-consumed `quoteId` returns the existing confirmed payment result instead of double-activating a subscription.
- **[wallet binding]** Payment verification requires the transaction sender to match the authenticated wallet used for the session.
- **[quota enforcement]** DB-backed project traffic now enforces plan quotas for per-minute reads/writes, batch size, websocket access, and monthly requests.
- **[legacy fallback]** Legacy `API_KEYS` still work as a migration fallback for registered rate limits, but they do not carry DB-backed project subscription state.
- **[usage metering]** Successful DB-backed project requests and websocket connects increment monthly usage counters in Postgres.
- **[websocket gating]** WebSocket upgrades are allowed only when the resolved DB-backed project plan has `websocketEnabled = true` and the project has remaining monthly quota.

## Database

This worker connects to a Postgres database with `seaport_orders`, `order_activity`, and migration metadata in `_migrations`.
Run `scripts/migrate.ts` to apply all SQL files in `migrations/`.

## License

MIT
