# Start Here

This is the canonical entry point for the Open Order Book documentation.

Use this page to choose the shortest path based on what you want to do.

---

## Choose Your Path

### I want to integrate OOB into a marketplace, bot, or agent

Read in this order:

1. [Integration Guide](./integration-guide.md)
2. [API Reference](./api-reference.md)
3. [packages/sdk/README.md](../packages/sdk/README.md)

Choose this path if you want to:

- read listings and offers
- submit signed orders
- fill orders on-chain
- add marketplace fees
- use WebSocket updates
- understand when project API keys help

### I want to self-host or operate the infrastructure

Read in this order:

1. [Architecture](./architecture.md)
2. [packages/api/README.md](../packages/api/README.md)
3. [packages/indexer/README.md](../packages/indexer/README.md)
4. [README.md](../README.md)

Choose this path if you want to:

- deploy the API worker and indexer
- configure database, RPC, rate limiting, and Durable Objects
- run migrations
- understand the subscription/auth/access model
- operate production infrastructure safely

### I only want the SDK

Start with:

1. [packages/sdk/README.md](../packages/sdk/README.md)
2. [API Reference](./api-reference.md)

### I only want the raw API

Start with:

1. [API Reference](./api-reference.md)
2. [Integration Guide](./integration-guide.md)
3. [packages/api/README.md](../packages/api/README.md)

---

## Current Access Model

- **Public reads** do not require an API key.
- **Writes** remain available without registration, but are rate-limited.
- **DB-backed project API keys** provide plan-based entitlements such as higher throughput, batch-size control, websocket gating, and monthly quota enforcement.
- **Legacy `API_KEYS`** still exist as a migration fallback for older integrations.

---

## Recommended Reading Order

### For most integrators

1. `docs/start-here.md`
2. `docs/integration-guide.md`
3. `docs/api-reference.md`
4. `packages/sdk/README.md`

### For production deployment

1. `docs/start-here.md`
2. `docs/architecture.md`
3. `packages/api/README.md`
4. `packages/indexer/README.md`

---

## Production Deployment Checklist

### API worker

1. Configure required secrets and bindings in `packages/api/wrangler.toml` and Cloudflare.
2. Run the API database migrations.
3. Verify payment, session, and protocol-fee configuration.
4. Deploy the API worker.

### Indexer worker

1. Point the indexer at the same Postgres database.
2. Configure webhook verification and RPC secrets.
3. Deploy the indexer worker.
4. Configure your webhook provider routes.

### Recommended launch order

1. Apply database migrations.
2. Deploy the API worker.
3. Deploy the indexer worker.
4. Run health checks and one end-to-end smoke test.

---

## Document Roles

- **`README.md`** — project overview and top-level navigation
- **`docs/start-here.md`** — canonical documentation entry point
- **`docs/integration-guide.md`** — how to use OOB in real product scenarios
- **`docs/api-reference.md`** — endpoint-by-endpoint API behavior
- **`docs/architecture.md`** — how the system works and how to self-host it
- **`packages/sdk/README.md`** — SDK-specific usage and API
- **`packages/api/README.md`** — API worker setup, env vars, and rollout notes
