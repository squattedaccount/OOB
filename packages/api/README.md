# OOB API

Public REST API for the [Open Order Book](https://github.com/openorderbook/sdk). Runs as a Cloudflare Worker.

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

See the full [API Reference](../../docs/api-reference.md) for details.

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

# Protocol fee enforcement (required)
wrangler secret put PROTOCOL_FEE_RECIPIENT
```

### Run database migrations

```bash
DATABASE_URL=postgres://... npx tsx scripts/migrate.ts
```

### Development

```bash
npm run dev
```

### Deploy

```bash
npm run deploy
```

## Environment Variables

| Variable | Type | Required | Description |
|---|---|---|---|
| `DATABASE_URL` | secret | **yes** | Neon Postgres connection string |
| `PROTOCOL_FEE_RECIPIENT` | secret | **yes** | Fee recipient enforced during order submission |
| `PROTOCOL_FEE_BPS` | var | no | Protocol fee bps (default: 50) |
| `API_KEYS` | secret/var | no | Comma-separated API keys for registered tier |
| `RATE_LIMIT_PUBLIC_READS` | var | no | Public read limit per minute (default: 60) |
| `RATE_LIMIT_PUBLIC_WRITES` | var | no | Public write limit per minute (default: 10) |
| `RATE_LIMIT_REGISTERED_READS` | var | no | Registered read limit per minute (default: 300) |
| `RATE_LIMIT_REGISTERED_WRITES` | var | no | Registered write limit per minute (default: 60) |
| `DO_SHARD_COUNT` | var | no | WebSocket shard count per room (default: 1) |
| `INTERNAL_SECRET` | secret | no | Internal auth for DO broadcasts |
| `OOB_RATE_LIMIT` | KV binding | no | KV namespace for distributed rate limiting |
| `ORDER_STREAM` | DO binding | no | Durable Object namespace for WebSocket streams |

## Database

This worker connects to a Postgres database with `seaport_orders`, `order_activity`, and migration metadata in `_migrations`.
Run `scripts/migrate.ts` to apply all SQL files in `migrations/`.

## License

MIT
