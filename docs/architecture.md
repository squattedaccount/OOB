# Architecture

This document explains how the Open Order Book works under the hood, the infrastructure decisions behind it, and how to self-host your own instance.

---

## Table of Contents

- [System Overview](#system-overview)
- [Components](#components)
- [Data Flow](#data-flow)
- [Infrastructure](#infrastructure)
- [Database Schema](#database-schema)
- [Fee Safety Model](#fee-safety-model)
- [Order Validation](#order-validation)
- [Staleness Management](#staleness-management)
- [Real-Time Events (WebSocket)](#real-time-events-websocket)
- [Rate Limiting](#rate-limiting)
- [Scaling Considerations](#scaling-considerations)
- [Self-Hosting](#self-hosting)
- [Open Source Philosophy](#open-source-philosophy)

---

## System Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                        Consumers                                │
│                                                                 │
│  Marketplaces    Bots    AI Agents    Traders    Dashboards     │
│       │           │         │            │           │          │
│       └───────────┴─────────┴────────────┴───────────┘          │
│                           │                                     │
│                    ┌──────┴──────┐                               │
│                    │  @oob/sdk   │  (optional — REST works too)  │
│                    └──────┬──────┘                               │
│                           │                                     │
│                    ┌──────┴──────┐                               │
│                    │   OOB API   │  api.openorderbook.xyz        │
│                    │  (CF Worker)│  REST + WebSocket              │
│                    └──────┬──────┘                               │
│                           │                                     │
│                    ┌──────┴──────┐                               │
│                    │  Postgres   │  Neon (serverless)            │
│                    │  (DB)       │  seaport_orders table         │
│                    └──────┬──────┘                               │
│                           │                                     │
│                    ┌──────┴──────┐                               │
│                    │ OOB Indexer │  On-chain event listener      │
│                    │ (CF Worker) │  OrderFulfilled, Transfer     │
│                    └─────────────┘                               │
│                                                                 │
│  ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─  │
│                                                                 │
│                    ┌─────────────┐                               │
│                    │  Seaport    │  On-chain settlement          │
│                    │  v1.6       │  (immutable smart contract)   │
│                    └─────────────┘                               │
└─────────────────────────────────────────────────────────────────┘
```

**Three layers:**

1. **API Layer** — Cloudflare Worker serving REST + WebSocket endpoints
2. **Storage Layer** — Postgres database holding all orders
3. **Indexer Layer** — Monitors on-chain events to update order statuses (filled, stale)

The SDK is a convenience wrapper around the API. Everything the SDK does can be done via raw HTTP + on-chain transactions.

---

## Components

### OOB API (`oob-api/`)

A Cloudflare Worker that serves the public REST API.

- **Runtime**: Cloudflare Workers (V8 isolates, global edge deployment)
- **No cold starts**: Workers are always warm
- **Stateless**: Each request connects to Postgres independently
- **CORS enabled**: Browser-safe, any origin

**Routes:**

| Method | Path | Description |
|---|---|---|
| GET | `/v1/orders` | Query orders with filters |
| GET | `/v1/orders/:hash` | Get single order |
| GET | `/v1/orders/best-listing` | Cheapest active listing |
| GET | `/v1/orders/best-offer` | Highest active offer |
| POST | `/v1/orders` | Submit a signed order |
| DELETE | `/v1/orders/:hash` | Cancel an order |
| GET | `/v1/collections/:addr/stats` | Collection statistics |
| WSS | `/v1/stream` | Real-time event stream |
| GET | `/health` | Health check |

### OOB SDK (`oob-sdk/`)

TypeScript/JavaScript SDK for interacting with the API and Seaport contracts.

- **Peer dependency**: `viem` (modern, lightweight Ethereum library)
- **No `@opensea/seaport-js`**: We sign Seaport orders directly via EIP-712 using viem's `signTypedData`. This avoids the ethers v6 dependency and the complex provider/signer bridge.
- **Dual build**: ESM + CJS with TypeScript declarations
- **Tree-shakeable**: Only import what you use

### OOB Indexer (planned)

A separate Cloudflare Worker that monitors on-chain Seaport events:

- `OrderFulfilled` — marks orders as `filled`, records tx hash
- `OrderCancelled` — marks orders as `cancelled`
- `Transfer` (ERC721/ERC1155) — detects NFT transfers that make listings stale

This runs on a cron schedule (every 1-5 minutes) and updates the database.

---

## Data Flow

### Creating a listing

```
User's Wallet
    │
    │ 1. signTypedData (EIP-712, gasless)
    │
    ▼
SDK / Direct API call
    │
    │ 2. POST /v1/orders { chainId, order, signature }
    │
    ▼
OOB API Worker
    │
    │ 3. Validate order structure
    │ 4. Extract NFT, price, fees
    │ 5. Compute order hash
    │ 6. INSERT into seaport_orders
    │
    ▼
Postgres
    │
    │ 7. Broadcast to WebSocket subscribers
    │
    ▼
All connected clients receive { type: "new_listing", order: {...} }
```

### Filling an order (buying)

```
Buyer's Wallet
    │
    │ 1. SDK fetches order from API (GET /v1/orders/:hash)
    │ 2. SDK constructs fulfillOrder transaction
    │ 3. Optional: adds tip for marketplace fee
    │
    ▼
Seaport v1.6 Contract (on-chain)
    │
    │ 4. Validates signature
    │ 5. Transfers NFT: seller → buyer
    │ 6. Transfers payment: buyer → seller
    │ 7. Transfers fee: buyer → OOB protocol
    │ 8. Transfers tip: buyer → marketplace (if any)
    │ 9. Emits OrderFulfilled event
    │
    ▼
OOB Indexer (cron)
    │
    │ 10. Detects OrderFulfilled event
    │ 11. UPDATE seaport_orders SET status = 'filled'
    │
    ▼
Postgres updated, WebSocket broadcasts { type: "sale", ... }
```

---

## Infrastructure

### Why Cloudflare Workers?

| Factor | Cloudflare Workers | AWS Lambda | Traditional Server |
|---|---|---|---|
| Cold starts | None (0ms) | 100-500ms | None |
| Global distribution | 300+ edge locations | ~20 regions | 1 region |
| Pricing | $0.50/million requests | $0.20/million + compute | Fixed monthly |
| WebSocket support | Via Durable Objects | Via API Gateway ($$$) | Native |
| Scaling | Automatic, instant | Automatic, slower | Manual |
| Maintenance | Zero | Low | High |

For an order book API that bots hit from around the world with low-latency requirements, edge compute is ideal.

### Why Neon Postgres?

| Factor | Neon | PlanetScale | Supabase | Self-hosted Postgres |
|---|---|---|---|---|
| Serverless | Yes | Yes | Partial | No |
| Scale to zero | Yes | Yes | No | No |
| Branching (dev) | Yes | Yes | No | No |
| SQL dialect | Postgres | MySQL | Postgres | Postgres |
| CF Worker compat | Excellent | Good | Good | Needs proxy |
| Pricing | Free tier, then usage | Free tier, then usage | Free tier, then fixed | Fixed |

Neon is the best fit because:
- Native Postgres (no MySQL quirks)
- Serverless connection pooling works perfectly with Cloudflare Workers
- Branch databases for development/staging
- Scale to zero when not in use (cost efficient)

### Why separate from the marketplace?

The Open Order Book runs on **completely separate infrastructure** from any marketplace that uses it (including nodz.space):

- **Separate database** — OOB queries don't compete with marketplace queries
- **Separate domain** — `api.openorderbook.xyz` vs `nodz.space`
- **Separate worker** — Independent scaling and rate limits
- **Separate indexer** — OOB only indexes Seaport events, not marketplace-specific data

This separation is critical for:
1. **Reliability** — A spike in bot traffic on OOB doesn't slow down the marketplace
2. **Open source** — OOB code is fully open, marketplace code stays private
3. **Trust** — Third-party integrators trust a neutral, independent infrastructure
4. **Scaling** — Different traffic patterns (bots = constant, marketplace = bursty)

---

## Database Schema

Single table: `seaport_orders`

```sql
CREATE TABLE seaport_orders (
    order_hash        TEXT PRIMARY KEY,
    chain_id          INTEGER NOT NULL,
    order_type        TEXT NOT NULL,             -- 'listing' | 'offer'
    offerer           TEXT NOT NULL,
    zone              TEXT DEFAULT '0x0000000000000000000000000000000000000000',

    -- NFT details
    nft_contract      TEXT NOT NULL,
    token_id          TEXT NOT NULL,
    token_standard    TEXT NOT NULL DEFAULT 'ERC721',

    -- Price details
    price_wei         TEXT NOT NULL,             -- stored as text for precision
    currency          TEXT NOT NULL,

    -- Fee details
    fee_recipient     TEXT NOT NULL,
    fee_bps           INTEGER NOT NULL DEFAULT 50,

    -- Royalty (optional)
    royalty_recipient  TEXT,
    royalty_bps        INTEGER DEFAULT 0,

    -- Full order data for on-chain fulfillment
    order_json        JSONB NOT NULL,
    signature         TEXT NOT NULL,

    -- Timestamps
    start_time        BIGINT NOT NULL,
    end_time          BIGINT NOT NULL,
    created_at        TIMESTAMPTZ DEFAULT NOW(),

    -- Status tracking
    status            TEXT NOT NULL DEFAULT 'active',
    filled_tx_hash    TEXT,
    filled_at         TIMESTAMPTZ,
    cancelled_tx_hash TEXT,
    cancelled_at      TIMESTAMPTZ
);

-- Indexes for common query patterns
CREATE INDEX idx_seaport_orders_collection ON seaport_orders (chain_id, nft_contract, status);
CREATE INDEX idx_seaport_orders_token ON seaport_orders (chain_id, nft_contract, token_id, status);
CREATE INDEX idx_seaport_orders_offerer ON seaport_orders (chain_id, offerer, status);
CREATE INDEX idx_seaport_orders_type_status ON seaport_orders (order_type, status);
CREATE INDEX idx_seaport_orders_expiry ON seaport_orders (end_time) WHERE status = 'active';
```

**Design decisions:**
- `price_wei` is `TEXT` not `NUMERIC` — avoids precision loss with very large numbers, sorting uses `CAST(price_wei AS NUMERIC)`
- `order_json` is `JSONB` — allows querying into the Seaport order structure if needed
- Partial index on `end_time` for active orders — fast expiry checks
- Composite indexes match the most common query patterns (collection + status, token + status)

---

## Fee Safety Model

The Open Order Book's fee model is **cryptographically enforced** — no trust required.

### How fees are embedded

When a listing is created for 1 ETH with a 0.5% protocol fee:

```json
{
  "consideration": [
    {
      "amount": "995000000000000000",
      "recipient": "0xSeller"
    },
    {
      "amount": "5000000000000000",
      "recipient": "0xOOBTreasury"
    }
  ]
}
```

The seller signs this exact structure. The Seaport contract will only execute the trade if **all** consideration items are satisfied. The fee cannot be removed without invalidating the signature.

### How marketplace tips work

Seaport allows the fulfiller (buyer) to add extra consideration items at fill time. These are called "tips":

```
Original order consideration:
  → 0.995 ETH to Seller
  → 0.005 ETH to OOB

Fulfiller adds tip:
  → 0.01 ETH to Marketplace

Total buyer pays: 1.01 ETH
```

The tip is enforced atomically — if the buyer doesn't have enough ETH for price + tip, the entire transaction reverts.

### Why this is safe

1. **Protocol fee can't be removed** — it's in the signed order
2. **Marketplace fee can't be stolen** — it's added by the fulfiller's own transaction
3. **Seller gets exactly what they signed for** — Seaport guarantees it
4. **No intermediary holds funds** — everything settles in one atomic transaction

---

## Order Validation

When an order is submitted via `POST /v1/orders`, the API validates:

1. **Chain ID** — must be a supported chain
2. **Structure** — must contain an NFT in `offer` (listing) or `consideration` (offer)
3. **Expiry** — `endTime` must be in the future
4. **Offerer** — must be present
5. **Deduplication** — order hash must not already exist

**Not validated at submission time** (validated by Seaport at fill time):
- Signature validity (Seaport verifies on-chain)
- NFT ownership (checked on-chain)
- Seaport approval (checked on-chain)
- Sufficient balance (checked on-chain)

This is intentional — the API is a **relay**, not a validator. Invalid orders will simply fail when someone tries to fill them, and the indexer will mark them as stale.

---

## Staleness Management

Orders can become invalid after submission:
- NFT is transferred to another wallet
- Seaport approval is revoked
- ERC20 balance drops below offer amount
- Seaport counter is incremented (bulk cancel)

The OOB Indexer handles this:

1. **Cron job** (every 1-5 minutes) checks active orders
2. For each active order, verify:
   - NFT still owned by offerer (for listings)
   - Seaport still approved (for listings)
   - ERC20 balance sufficient (for offers)
   - Order not filled on-chain
3. Mark invalid orders as `stale`

Stale orders are excluded from `active` queries but kept in the database for history.

---

## Real-Time Events (WebSocket)

### How it works

WebSocket connections are managed by **Cloudflare Durable Objects** — a stateful compute primitive that runs alongside Workers.

```
Client A ──WSS──┐
Client B ──WSS──┤── Durable Object (per collection) ──── Postgres
Client C ──WSS──┘
```

Each collection gets its own Durable Object instance that:
1. Accepts WebSocket connections
2. Maintains a list of connected clients
3. When a new order is submitted (POST /v1/orders), the API notifies the relevant Durable Object
4. The Durable Object broadcasts the event to all connected clients

### Why Durable Objects?

- **No separate WebSocket server** — runs on the same Cloudflare infrastructure
- **Automatic scaling** — each collection is independent
- **Global** — clients connect to the nearest edge location
- **Persistent** — survives individual request lifecycles

### Event types

| Event | Trigger |
|---|---|
| `new_listing` | POST /v1/orders with a listing |
| `new_offer` | POST /v1/orders with an offer |
| `sale` | Indexer detects OrderFulfilled event |
| `cancellation` | DELETE /v1/orders/:hash |
| `price_change` | Old listing cancelled + new listing created for same token |

---

## Rate Limiting

Rate limiting is implemented using Cloudflare KV (key-value store) for distributed counting.

### How it works

1. Each request is identified by IP address (public) or API key (registered)
2. A counter in KV tracks requests per minute
3. If the counter exceeds the limit, return `429 Too Many Requests`
4. Counters expire automatically after 60 seconds

### Tiers

| Tier | Reads/min | Writes/min | Identification |
|---|---|---|---|
| Public | 60 | 10 | IP address |
| Registered | 300 | 60 | `X-API-Key` header |
| Premium | 1000+ | 200+ | `X-API-Key` header |

### Why these limits?

- **Public 60/min** — enough for a dashboard refreshing every second, too slow for aggressive bots (encourages WebSocket)
- **Registered 300/min** — enough for a marketplace with moderate traffic
- **Premium 1000+/min** — for high-frequency trading bots and large marketplaces

---

## Scaling Considerations

### Current capacity (Cloudflare Workers + Neon Free Tier)

- ~1,000 requests/second (Workers)
- ~100 concurrent DB connections (Neon)
- ~500MB storage (Neon free tier)

### Scaling path

| Stage | Traffic | Action |
|---|---|---|
| Launch | <100 req/s | Current setup is fine |
| Growth | 100-1000 req/s | Upgrade Neon plan, add read replicas |
| Scale | 1000-10000 req/s | Add Cloudflare KV caching for hot queries (best-listing, stats) |
| High scale | 10000+ req/s | Add Cloudflare R2 for order archival, consider ClickHouse for analytics |

**Key insight**: The bottleneck is always the database, not the compute. Cloudflare Workers scale infinitely. The strategy is to cache aggressively and minimize DB hits.

### Caching strategy

| Query | Cache TTL | Why |
|---|---|---|
| `best-listing` | 5-10 seconds | Changes infrequently, most queried |
| `collection/stats` | 30 seconds | Aggregate data, expensive query |
| `orders` (list) | 5 seconds | Frequently changing |
| `orders/:hash` | 60 seconds | Individual orders rarely change |
| POST/DELETE | No cache | Writes always go to DB |

---

## Self-Hosting

You can run your own Open Order Book instance. Here's how.

### Prerequisites

- Cloudflare account (free tier works)
- Neon Postgres account (free tier works)
- Node.js 18+
- `wrangler` CLI (`npm install -g wrangler`)

### Step 1: Clone and install

```bash
git clone https://github.com/openorderbook/sdk.git
cd sdk/oob-api
npm install
```

### Step 2: Create database

Create a Neon project and run the migration:

```sql
-- Copy from migrations/001_seaport_orders.sql
CREATE TABLE seaport_orders ( ... );
-- Create indexes
CREATE INDEX ...;
```

### Step 3: Configure secrets

```bash
wrangler secret put DATABASE_URL
# Paste your Neon connection string
```

### Step 4: Deploy

```bash
wrangler deploy
```

Your API is now live at `https://oob-api.<your-subdomain>.workers.dev`.

### Step 5: Custom domain (optional)

In the Cloudflare dashboard, add a custom domain route for your worker.

### Customization

You can customize:
- **Fee recipient** — change `OOB_FEE_RECIPIENT` in the order validation
- **Supported chains** — modify the `validChains` array
- **Rate limits** — adjust `RATE_LIMIT_READS_PER_MIN` and `RATE_LIMIT_WRITES_PER_MIN` in `wrangler.toml`

---

## Open Source Philosophy

The Open Order Book is fully open source under the MIT license.

### What's open

- **@oob/sdk** — The TypeScript SDK
- **oob-api** — The API worker
- **Documentation** — Everything in this `docs/` folder
- **Database schema** — The migration files

### What's private

- **Deployment secrets** — DATABASE_URL, API keys, treasury address
- **Marketplace-specific code** — nodz.space frontend and backend are separate projects

### Why open source?

1. **Trust** — Bots and marketplaces can verify the code doesn't do anything malicious
2. **Adoption** — Developers can contribute, find bugs, build integrations
3. **Standard** — Seaport is open source, Reservoir was open source — this is expected in web3
4. **The moat isn't the code** — it's the liquidity (orders) and the network effect. More integrators = more orders = more value for everyone.

### Contributing

See [CONTRIBUTING.md](../CONTRIBUTING.md) for guidelines.
