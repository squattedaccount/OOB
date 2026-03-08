# Open Order Book (OOB)

Open-source NFT order book protocol built on [Seaport](https://github.com/ProjectOpenSea/seaport).

**Open liquidity. Public reads. Optional higher-throughput access via project API keys. No vendor lock-in.**

Any marketplace, bot, or AI agent can read and write orders through a single shared book.

## Architecture

```
┌─────────────┐     ┌─────────────┐     ┌──────────────┐
│  Your App   │────▶│   OOB API   │────▶│              │
│  (SDK/REST) │◀────│  (CF Worker) │◀────│  Neon        │
└─────────────┘     └──────┬──────┘     │  Postgres    │
                           │            │  (Orders DB) │
                    ┌──────▼──────┐     │              │
                    │  WebSocket  │     │              │
                    │  (Durable   │     └──────▲───────┘
                    │   Objects)  │            │
                    └─────────────┘     ┌──────┴───────┐
                                        │ OOB Indexer  │
  Seaport v1.6 ─── Alchemy/Moralis ───▶│ (CF Worker)  │
  on-chain events   webhooks            │ cron: expire │
                                        │ + stale check│
                                        └──────────────┘
```

## Packages

| Package | Description | Path |
|---------|-------------|------|
| **@oob/sdk** | TypeScript SDK for interacting with the order book | `packages/sdk` |
| **oob-api** | Cloudflare Worker — the public REST + WebSocket API | `packages/api` |
| **@oob/indexer** | Cloudflare Worker — on-chain event monitor + order lifecycle | `packages/indexer` |

## Quick Start

```bash
# Install all dependencies
npm install

# Run API locally
npm run dev:api

# Run Indexer locally
npm run dev:indexer

# Build SDK
npm run build

# Run SDK tests
npm run test
```

For a guided onboarding flow, start with [docs/start-here.md](docs/start-here.md).

## Start Here

- **[New integrator]** Start with [docs/start-here.md](docs/start-here.md), then read [docs/integration-guide.md](docs/integration-guide.md) and [docs/api-reference.md](docs/api-reference.md).
- **[Self-hoster / infra owner]** Start with [docs/start-here.md](docs/start-here.md), then read [docs/architecture.md](docs/architecture.md) and [packages/api/README.md](packages/api/README.md).
- **[SDK consumer]** Go to [packages/sdk/README.md](packages/sdk/README.md).
- **[API operator]** Go to [packages/api/README.md](packages/api/README.md).

## Current Access Model

- **Public reads** remain open with no API key required.
- **Writes** remain available without registration, but are rate-limited.
- **DB-backed project API keys** now support higher-throughput access, entitlement-based limits, monthly quotas, and WebSocket plan gating.
- **Legacy `API_KEYS`** still work as a migration fallback for registered-tier rate limits, but they do not carry project subscription state.

For subscription setup, wallet auth, and production env configuration, see `packages/api/README.md`.

## SDK Example

```typescript
import { OpenOrderBook } from '@oob/sdk';

const oob = new OpenOrderBook({
  apiUrl: 'https://api.openorderbook.xyz',
  chainId: 8453,
});

// Get listings for a collection
const { orders } = await oob.getListings({
  collection: '0xYourCollectionAddress',
});

// Get floor price
const floor = await oob.getBestListing({
  collection: '0xYourCollectionAddress',
});
```

## API Surface

| Method | Path | Description |
|--------|------|-------------|
| GET | `/v1/orders` | Query orders with filters (`tokenIds=1,2,3` supported) |
| GET | `/v1/orders/:hash` | Get single order by hash |
| GET | `/v1/orders/:hash/fill-tx` | Ready-to-sign fill transaction (for agents/bots) |
| POST | `/v1/orders/batch/fill-tx` | Batch fill-tx — sweep up to 20 listings at once |
| GET | `/v1/orders/best-listing` | Floor price for collection/token |
| GET | `/v1/orders/best-listing/fill-tx` | Floor snipe — best listing + fill-tx in one call |
| GET | `/v1/orders/best-offer` | Best offer for collection/token |
| POST | `/v1/orders` | Submit a signed Seaport order |
| POST | `/v1/orders/batch` | Batch submit up to 20 orders |
| DELETE | `/v1/orders/:hash` | Cancel order |
| DELETE | `/v1/orders/batch` | Batch cancel up to 20 orders |
| GET | `/v1/erc20/:token/approve-tx` | ERC20 approval calldata for Seaport (for agents) |
| GET | `/v1/collections/:addr/stats` | Collection stats |
| WS | `/v1/stream` | Real-time order events |

## Documentation

- [Start Here](docs/start-here.md)
- [API Reference](docs/api-reference.md)
- [Integration Guide](docs/integration-guide.md)
- [Architecture & Self-Hosting](docs/architecture.md)
- [API Worker Setup & Subscription Rollout](packages/api/README.md)
- [Indexer Setup & Operations](packages/indexer/README.md)

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT — see [LICENSE](LICENSE).
