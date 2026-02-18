# oob_todo

- [x] Enrich activity + order API responses with currency metadata (symbol + decimals) resolved per chain. — DONE (currency.ts with per-chain registry; mapRowToOrder + activity response include currencySymbol, currencyDecimals, priceDecimal)
  - Problem today: the site often only receives a `currency` address (or the zero address) + a raw `price` integer string.
    - For native tokens, we need per-chain symbol (ETH vs RON vs HYPE vs STT).
    - For ERC-20 / wrapped tokens, the UI can only guess (or shorten addresses), and decimals can be wrong.
  - What this enables:
    - Correct, consistent price rendering across REST + WS + order detail (no heuristics like “looks like wei”).
    - Clean UX for wrapped tokens (show `WETH`, `WRON`, `USDC` etc) everywhere.
    - Multiple clients benefit (web UI, bots, integrators) without each re-implementing token metadata logic.
  - Native currency: interpret 0x0000000000000000000000000000000000000000 as chain native token (ETH/RON/HYPE/STT/etc).
  - ERC-20 currencies: resolve `symbol()` + `decimals()` for known tokens (WETH/WRON/USDC/USDT/etc) and provide consistent formatting.
  - Prefer server-side resolution + caching so all clients get correct display without RPC calls from the browser.
  - Update `/v1/activity` + `/v1/orders/:hash` (and websocket stream payloads) to include `currencySymbol` and `currencyDecimals` (and optionally `priceDecimal`).
  - Ensure wrapped token currencies display as `WETH`, `WRON`, etc (not a shortened address).

- [x] Fix order activity querying to not depend on a frontend default chainId. — DONE (chainId optional when orderHash provided; added GET /v1/orders/:hash/activity convenience route)
  - Problem: the site currently queries order activity using `chainId=DEFAULT_FEED_CHAIN_ID`, which can be wrong when viewing orders from other chains.
  - Solution options:
    - Support `GET /v1/activity?orderHash=...` without requiring `chainId` (preferred if `orderHash` is globally unique).
    - Or add `GET /v1/orders/:hash/activity` to avoid any client-side guessing.

- [x] Add server-side filtering for activity feeds (REST + WebSocket) for scale. — DONE (REST: chainId, eventType, collection, address filters; WS: chainIds, collections, events filters via query params + subscribe messages)
  - Problem today: in “all chains” mode (and generally as volume grows), clients can end up receiving too many irrelevant events.
    - Bandwidth + CPU waste (every client parses/renders/dedupes events it will never display).
    - Makes real-time UI less stable on mobile / low-power devices.
    - Harder to support more chains + higher event throughput.
  - What this enables:
    - Efficient subscriptions (client only receives what it asked for).
    - Lower tail latency for UI updates and fewer reconnect/memory issues.
    - Makes it feasible to add richer filtering (collection, event types) without UI-side filtering hacks.
  - Goal: for 1000+ daily users, avoid sending every event to every client.
  - Recommendation:
    - REST: filter in `/v1/activity` by `chainId`, `eventType`, and other primary selectors.
    - WebSocket: allow subscription filters (`chainId`, `eventTypes`, maybe `collection`) so the Durable Object can broadcast only relevant events.
  - Clients should only do final UI-only filtering (search, highlighting), not primary filtering.

-----

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
