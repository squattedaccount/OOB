OOB Production Readiness Fixes

Bug Fixes
* ✅ Fix logActivityBatch to use actual batch INSERT — DONE (batch VALUES clause in activity.ts)
* ✅ Fix fee recipient parsing to handle 3+ party orders — DONE (shared parseOrderDetails + sum all non-OOB royalty amounts)
* ✅ Upgrade indexer wrangler to v4 — DONE (^4.58.0 in indexer/package.json)

Security Fixes
* ✅ Add auth to Durable Object /internal/broadcast endpoint — DONE (INTERNAL_SECRET Bearer check in stream.ts)
* ✅ Fix rate limit race condition (atomic increment) — DONE (15s windows + increment-first + burst limiter)
* 💬 CORS — DISCUSSION (still Access-Control-Allow-Origin: *, see recommendations below)
* ✅ Add request logging/audit trail for write operations — DONE (audit.ts + index.ts calls it for writes)
* ✅ Fix webhook secret fallback (add monitoring) — DONE (CRITICAL log + reject-all in indexer/webhook.ts)
* ✅ Fix ethers dynamic import → static import — DONE (static import at top of orders.ts)

Production Readiness
* 💬 Add API integration tests — DISCUSSION (large scope, see recommendations below)
* 💬 Recommend DB connection pooling strategy — DISCUSSION (fetchConnectionCache=true is partial, see below)
* 💬 Recommend monitoring/alerting strategy — DISCUSSION (see recommendations below)
* ✅ Add migration runner script — DONE (scripts/migrate.ts + npm run migrate)
* ✅ Wire up WebSocket broadcast from order routes — DONE (broadcastOrderEvent on submit + cancel)
* ✅ Fix ERC1155 quantity handling in SDK — DONE (tokenStandard + quantity params in types/seaport)
* ✅ Add cursor-based pagination — DONE (keyset pagination with nextCursor, backward-compat offset)
* ✅ Add database index for price sorting — DONE (migration 004_price_sorting_index.sql)
* 💬 Add API versioning strategy — DISCUSSION (see recommendations below)
* ✅ Add SDK retry/backoff logic — DONE (fetchWithRetry with exponential backoff in api.ts)
* ✅ Extract duplicated order parsing into shared function — DONE (parseOrderDetails shared helper)
* ✅ Remove solc dependency from indexer — DONE (no solc in indexer/package.json)
* ✅ Add SDK input validation — DONE (validateAddress + validatePositiveBigInt in client.ts)
* ✅ Fix getListings method signature inconsistency — DONE (accepts both string and params-object)
* ✅ Add SDK CHANGELOG.md — DONE (packages/sdk/CHANGELOG.md)

---

Discussion Items & Recommendations

### CORS (Access-Control-Allow-Origin: *)
The current wildcard CORS is fine for a public read API. However, write endpoints
(POST /v1/orders, DELETE /v1/orders/:hash) are already protected by API key + signature
verification, so CORS is not the security boundary. Options:
  - **Keep `*`** if the SDK/API is meant to be called from any frontend (marketplace integrators).
  - **Restrict to known origins** if only your own frontend calls the API. Set via env var:
    `ALLOWED_ORIGINS=https://app.oob.exchange,https://staging.oob.exchange`
  - Recommendation: **keep `*` for now** since this is a public protocol API. The real auth is API keys + EIP-712 signatures.

### DB Connection Pooling
Neon's `fetchConnectionCache = true` is already the recommended approach for Cloudflare Workers
(HTTP-based, no persistent TCP). For higher throughput:
  - Enable Neon's **connection pooler** (PgBouncer) in the Neon dashboard and use the pooled connection string.
  - No code changes needed — just swap `DATABASE_URL` to the pooled endpoint.

### Monitoring / Alerting
Recommended stack for Cloudflare Workers:
  - **Cloudflare Analytics Engine** — free, built-in, for request metrics.
  - **Logpush** to Datadog/Grafana Cloud for structured log aggregation (audit logs are already JSON).
  - **Uptime checks** via Cloudflare Health Checks or Better Uptime for endpoint availability.
  - **Sentry** (CF Workers SDK) for error tracking with stack traces.
  - Add a `/health` endpoint that checks DB connectivity for external monitors.

### API Versioning
Current API is already versioned at `/v1/`. Recommendation:
  - When breaking changes are needed, deploy `/v2/` routes alongside `/v1/`.
  - Add a `Sunset` header to deprecated versions with a deprecation date.
  - Document version lifecycle in README.

### API Integration Tests
This is a large-scope item. Recommended approach:
  - Use `vitest` + `miniflare` (Cloudflare's local simulator) for integration tests.
  - Start with the critical paths: submit order → get order → cancel order.
  - Add to CI pipeline. Can be tackled as a separate sprint.
