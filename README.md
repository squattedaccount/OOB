# Open Order Book (OOB)

A decentralized, open-source NFT order book protocol built on [Seaport](https://github.com/ProjectOpenSea/seaport).

**No gatekeepers. No API keys required. No vendor lock-in.**

Any marketplace, bot, or AI agent can read and write orders through a single shared book.

## Architecture

```
┌─────────────┐     ┌─────────────┐     ┌──────────────┐
│  Your App   │────▶│   OOB API   │────▶│  Neon Postgres│
│  (SDK/REST) │◀────│  (CF Worker) │◀────│  (Orders DB)  │
└─────────────┘     └──────┬──────┘     └──────────────┘
                           │
                    ┌──────▼──────┐
                    │  WebSocket  │
                    │  (Durable   │
                    │   Objects)  │
                    └─────────────┘
```

## Packages

| Package | Description | Path |
|---------|-------------|------|
| **@oob/sdk** | TypeScript SDK for interacting with the order book | `packages/sdk` |
| **oob-api** | Cloudflare Worker — the public REST + WebSocket API | `packages/api` |

## Quick Start

```bash
# Install all dependencies
npm install

# Run API locally
npm run dev:api

# Build SDK
npm run build

# Run SDK tests
npm run test
```

## SDK Usage

```typescript
import { OpenOrderBook } from '@oob/sdk';

const oob = new OpenOrderBook({
  apiUrl: 'https://oob-api.sm-p.workers.dev',
  chainId: 1,
});

// Get listings for a collection
const { orders } = await oob.getListings({
  collection: '0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D',
});

// Get floor price
const floor = await oob.getBestListing({
  collection: '0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D',
});
```

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/v1/orders` | Query orders with filters |
| GET | `/v1/orders/:hash` | Get single order by hash |
| GET | `/v1/orders/best-listing` | Floor price for collection/token |
| GET | `/v1/orders/best-offer` | Best offer for collection/token |
| POST | `/v1/orders` | Submit a signed Seaport order |
| DELETE | `/v1/orders/:hash` | Cancel order (requires txHash) |
| GET | `/v1/collections/:addr/stats` | Collection stats |
| WS | `/v1/stream` | Real-time order events |

## Documentation

- [API Reference](docs/api-reference.md)
- [Integration Guide](docs/integration-guide.md)
- [Architecture & Self-Hosting](docs/architecture.md)

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT — see [LICENSE](LICENSE).
