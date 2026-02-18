# OOB API

Public REST API for the [Open Order Book](https://github.com/openorderbook/sdk). Runs as a Cloudflare Worker.

## Endpoints

| Method | Path | Description |
|---|---|---|
| GET | `/v1/orders` | Query orders with filters |
| GET | `/v1/orders/:hash` | Get single order by hash |
| GET | `/v1/orders/best-listing` | Cheapest active listing |
| GET | `/v1/orders/best-offer` | Highest active offer |
| POST | `/v1/orders` | Submit a signed Seaport order |
| DELETE | `/v1/orders/:hash` | Cancel an order |
| GET | `/v1/collections/:addr/stats` | Collection statistics |
| GET | `/health` | Health check |

See the full [API Reference](../oob-sdk/docs/api-reference.md) for details.

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
| `API_ADMIN_TOKEN` | secret | no | Admin token for protected endpoints |
| `RATE_LIMIT_READS_PER_MIN` | var | no | Read rate limit (default: 120) |
| `RATE_LIMIT_WRITES_PER_MIN` | var | no | Write rate limit (default: 30) |

## Database

This worker connects to a Postgres database with the `seaport_orders` table. See the migration in `migrations/001_seaport_orders.sql`.

## License

MIT
