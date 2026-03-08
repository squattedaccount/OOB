# Open Order Book Project Audit

Date: 2026-03-06
Scope: static audit of `packages/api`, `packages/indexer`, `packages/sdk`, migrations, CI, and core docs.
Method: code review only. I did not deploy or run production infrastructure. Findings below are based on repository state at audit time.

## Executive Summary

Overall, the project has a strong architectural direction and several good safety measures already in place:

- protocol-fee enforcement is explicit and fairly well tested
- request-body limits and webhook verification exist in the critical ingress paths
- the codebase is logically separated into API, SDK, and indexer responsibilities
- the fee model has been thought through more carefully than most early-stage NFT infra projects

That said, I found several high-risk issues that should be addressed before treating the system as production-hardened.

The biggest problems are:

1. the SDK offer-construction path appears to build economically incorrect or invalid offer orders
2. queued order ingestion does not enforce the same business invariants as synchronous ingestion
3. market-data endpoints compare raw `price_wei` across different currencies, which can produce incorrect floors / best offers / ordering
4. the API can emit order events before queued persistence succeeds
5. Redis deduplication can temporarily create ghost duplicates after failed writes

## Severity Legend

- Critical: likely breaks core order correctness or can produce invalid economic behavior
- High: likely causes inconsistent state, incorrect market behavior, or production incidents
- Medium: meaningful reliability, observability, or product-risk issue
- Low: cleanup or process gap worth fixing but not immediately dangerous

## Findings

### 1. Critical: `sdk.createOffer()` appears to omit the seller payout consideration item

Severity: Critical
Affected area: `packages/sdk/src/seaport.ts`, `packages/sdk/src/client.ts`

#### Evidence

In `SeaportClient.createOffer()`:

- the `offer` side contains a single ERC20 payment item for `amountWei`
- the `consideration` array starts with the NFT going to the offerer
- protocol fee, origin fee, and royalty recipients are appended as ERC20 consideration items
- there is no ERC20 consideration item paying the seller / fulfiller

This means the offer order contains:

- ERC20 offered by buyer
- NFT requested by buyer
- optional fee recipients
- but no explicit seller payment recipient

#### Why this is dangerous

For an offer order, the seller must receive proceeds somewhere in the signed order semantics. As implemented, the order appears to direct ERC20 only to fee recipients while omitting the seller payout path entirely.

Best case:

- these orders are invalid and revert on fulfillment

Worst case:

- there is a semantic misunderstanding in the SDK, and the order economics are not what the API / docs / integrators believe they are

Either way, this is a core trading-path issue.

#### Business impact

- bids created via SDK may be unusable
- integrators may think offers are working while generating broken off-chain liquidity
- trust damage is high if users sign offers that cannot settle as expected

#### Recommendation

- audit Seaport offer semantics immediately
- add explicit tests for `createOffer()` against known-valid Seaport order shapes
- verify on-chain fulfillment in an integration test
- do not promote SDK offer creation as stable until this is fixed and tested end-to-end

---

### 2. High: queued ingestion does not enforce the same invariants as synchronous ingestion

Severity: High
Affected area: `packages/api/src/routes/orders.ts`, `packages/api/src/queue.ts`

#### Evidence

The synchronous `POST /v1/orders` path enforces:

- duplicate active listing prevention for same `(offerer, chain, collection, token)`
- per-offerer cap via `MAX_ACTIVE_ORDERS_PER_OFFERER`

But when `ORDER_INGEST_QUEUE` is enabled:

- the API validates and enqueues
- the queue worker bulk-inserts rows
- the queue worker only checks duplicate `order_hash`
- it does not replicate the duplicate-listing invariant
- it does not replicate the per-offerer active-order cap

#### Why this is dangerous

The behavior of the system changes materially depending on deployment configuration.

That means:

- an environment with queueing enabled may accept orders that a non-queued environment rejects
- business rules are no longer authoritative in one place
- ops can accidentally weaken marketplace invariants just by enabling the queue

#### Business impact

- same seller can have multiple active listings for one token
- active-order caps can be bypassed under load
- market state diverges across environments

#### Recommendation

- move authoritative write invariants into DB constraints or queue-safe SQL
- ensure queue consumer enforces the exact same invariants as synchronous path
- add tests for queued vs non-queued parity

---

### 3. High: queued path broadcasts `new_listing` / `new_offer` before persistence succeeds

Severity: High
Affected area: `packages/api/src/routes/orders.ts`, `packages/api/src/queue.ts`

#### Evidence

In the queued path, `handleSubmitOrder()`:

- sends to `ORDER_INGEST_QUEUE`
- immediately broadcasts the websocket event
- returns `202 { status: "queued" }`

Persistence happens later in the queue worker.

If the queue consumer fails, retries, or DLQs the message, consumers may still have received a live event for an order that is not queryable and may never exist.

#### Why this is dangerous

This creates an event/data inconsistency:

- stream consumers see order creation before the DB is authoritative
- API consumers may query the order immediately and get not found
- if insertion ultimately fails, the stream emitted a phantom order

#### Business impact

- bot integrations can act on non-existent liquidity
- UI state can flicker or show orders that never materialize
- downstream systems lose trust in websocket stream correctness

#### Recommendation

- broadcast only after persistence succeeds
- if keeping async ingestion, emit a separate `queued` event or do not broadcast until the queue consumer inserts successfully
- consider queue-consumer broadcast as the single authoritative event source

---

### 4. High: Redis deduplication can create temporary ghost duplicates after failed writes

Severity: High
Affected area: `packages/api/src/cache.ts`, `packages/api/src/routes/orders.ts`

#### Evidence

`RedisCache.deduplicate()` uses Redis `SET NX EX` on the order hash before the DB write succeeds.

Submission flow:

- dedup key is set first
- DB insert happens afterward
- if DB insert or queue persistence fails, the dedup key remains for 300 seconds
- retries in that window can be treated as duplicates even though the order was never stored

#### Why this is dangerous

A temporary Neon outage or transient insert error can convert into user-visible false duplicate responses.

This is especially bad for order submission because it hides the original failure mode and makes recovery non-obvious.

#### Business impact

- users/bots can be blocked from resubmitting a legitimate order for 5 minutes
- support/debug burden increases because the API says “duplicate” while the DB has no record

#### Recommendation

- make DB persistence authoritative for dedup success
- or clear the Redis dedup key on write failure
- or use a two-phase status (`pending` -> `persisted`) instead of treating `SET NX` as proof of durable success

---

### 5. High: best-price and stats endpoints compare raw `price_wei` across mixed currencies

Severity: High
Affected area: `packages/api/src/routes/orders.ts`

#### Evidence

The following endpoints order or aggregate directly on `CAST(price_wei AS NUMERIC)`:

- `GET /v1/orders` when sorting by price
- `GET /v1/orders/best-listing`
- `GET /v1/orders/best-offer`
- `GET /v1/collections/:address/stats`

These queries do not constrain by `currency`.

That means native ETH, WETH, and any other ERC20 used on a chain can be ranked together as if raw integer magnitude were economically comparable.

#### Why this is dangerous

Raw wei amounts are only comparable within the same currency and decimal system. Even if many collections mostly use one currency, the API as written can produce wrong results as soon as a second currency appears.

Examples:

- a “floor” can point to a listing in a non-comparable token
- best offer can select the numerically largest token amount rather than the highest economic value
- collection stats can become misleading or unusable for integrators

#### Business impact

- wrong market data
- bad bot decisions
- misleading floors / best bids in UIs
- trust damage for third-party integrators

#### Recommendation

- require `currency` in endpoints where ordering assumes comparability
- or partition ranking/statistics by currency
- do not expose a single “best” cross-currency result unless you add external FX normalization, which is much more complex

---

### 6. Medium-High: documentation is materially out of sync with the actual implementation

Severity: Medium-High
Affected area: `docs/architecture.md`, fee docs, self-hosting guidance

#### Evidence

I found several examples of doc drift:

- architecture schema example still uses `fee_recipient` / `fee_bps`, while migration `001_seaport_orders.sql` now uses `protocol_fee_*` and `origin_fee_*`
- architecture says signature validity is not validated at submission time, but `handleSubmitOrder()` now verifies the EIP-712 signature before acceptance
- self-hosting/customization guidance references supported-chain modification in broad terms while chain support is spread across multiple hardcoded sets in multiple packages

#### Why this matters

This project positions itself as open infra. In open infra, docs are part of the API surface.

Doc drift here can mislead:

- self-hosters
- integrators re-implementing clients
- auditors trying to understand fee safety and validation guarantees

#### Recommendation

- treat `docs/architecture.md` as production-facing spec and keep it synchronized with code
- add a doc review checklist for schema and validation changes
- explicitly document what is verified at submission vs fill time vs indexer time

---

### 7. Medium: supported-chain definitions are inconsistent across packages

Severity: Medium
Affected area: `packages/api`, `packages/indexer`, `packages/sdk`

#### Evidence

API/indexer accept chain IDs including:

- `202601` (Ronin testnet)

But SDK `SUPPORTED_CHAINS` omits `202601`.

#### Why this matters

This causes environment drift:

- backend accepts chains the SDK type surface does not advertise
- docs and runtime capabilities can disagree
- test coverage is likely weaker for omitted chains

#### Recommendation

- centralize supported-chain metadata in one shared source of truth
- generate API/SDK/indexer constants from that source
- add a parity test to ensure all layers support the same chain set unless intentionally different

---

### 8. Medium: `counter_incremented` cancellation path loses tx provenance on stored orders

Severity: Medium
Affected area: `packages/indexer/src/lifecycle.ts`

#### Evidence

For `fulfilled` and `cancelled` lifecycle events, the indexer stores the tx hash on the order row.

For `counter_incremented`, it bulk-updates active orders to `cancelled` but only sets:

- `status = 'cancelled'`
- `cancelled_at = NOW()`

It does not store `cancelled_tx_hash = evt.txHash` on the affected orders.

#### Why this matters

Bulk cancel via Seaport counter increment is a real and important provenance event. Losing tx linkage makes debugging, analytics, and user-facing audit trails weaker.

#### Recommendation

- set `cancelled_tx_hash` for counter-based cancellations as well
- consider a distinct activity event type like `counter_cancelled` if you want richer provenance

---

### 9. Medium: queue-side cache invalidation is weaker than sync write invalidation

Severity: Medium
Affected area: `packages/api/src/routes/orders.ts`, `packages/api/src/queue.ts`

#### Evidence

Sync submission invalidates:

- best listing cache
- collection stats cache
- order-list caches

Queue consumer invalidates only:

- best listing cache
- collection stats cache

It does not invalidate order-list caches.

#### Why this matters

This is not catastrophic because TTLs are short, but it does create avoidable inconsistency between write modes.

#### Recommendation

- make cache invalidation parity match between sync and queued paths
- ideally centralize invalidation logic so behavior does not fork by ingestion mode

---

### 10. Medium: test coverage does not match the risk profile of the system

Severity: Medium
Affected area: CI + repo-wide test strategy

#### Evidence

Current CI runs `npm run build` and `npm run test`, but the root scripts only build/test the SDK workspace.

There are API tests, but root CI is not obviously executing package-local API checks.
There is effectively no first-party indexer test suite in the repo.

High-risk areas currently lack strong regression protection:

- queue vs sync parity
- SDK offer construction correctness
- mixed-currency best-price behavior
- indexer lifecycle and transfer processing

#### Why this matters

This repo touches order correctness, indexing correctness, and fee correctness. Those are exactly the areas where a narrow test surface leads to expensive production mistakes.

#### Recommendation

- make CI run `check` and `test` for `api`, `sdk`, and `indexer`
- add integration-style fixtures for valid Seaport listing and offer orders
- add tests for queue behavior parity and mixed-currency ranking

## Additional Observations

### Positive signals

- `handleSubmitOrder()` enforces actual body size limits instead of trusting `Content-Length`
- webhook handler enforces body-size limits and secret verification
- fee parsing has better-than-average explicitness around origin fees and royalties
- `GET /v1/orders/:hash/fill-tx?validate=true` has a reasonable fail-open owner check pattern for optional preflight validation

### Architectural theme behind most issues

Most of the higher-risk findings come from one underlying pattern:

- business invariants are enforced in application code, but not always in one authoritative place

You see this in:

- sync vs queued ingestion
- docs vs runtime behavior
- SDK vs backend supported-chain drift
- market-data endpoints assuming all `price_wei` are directly comparable

## Recommended Remediation Order

### Phase 1: immediate

1. fix or disable SDK `createOffer()` until seller payout semantics are proven correct
2. align queued ingestion with sync-path invariants
3. stop broadcasting queued orders before persistence succeeds
4. fix dedup so failed writes do not create false duplicates

### Phase 2: high-value correctness

5. make best-price and stats currency-aware
6. add parity tests for queued vs sync ingestion
7. extend CI to all workspaces

### Phase 3: platform hardening

8. centralize supported-chain definitions
9. restore doc accuracy for schema and validation behavior
10. improve lifecycle provenance for counter-based cancellations

## Suggested Refactors

### Refactor 1: central order-ingestion service

Create a single authoritative ingestion module used by:

- sync API path
- batch submit path
- queue consumer

That module should own:

- invariant validation
- dedup semantics
- DB write behavior
- cache invalidation planning
- event emission policy

### Refactor 2: central chain registry

Move chain metadata into one shared source used by:

- SDK supported chains
- API valid chains
- indexer RPC mapping
- docs/examples

### Refactor 3: explicit market-data semantics

Split order read APIs into either:

- currency-scoped endpoints

or

- multi-currency endpoints that return grouped results by currency

This is safer than pretending a single global ordering exists across arbitrary ERC20s.

## Final Assessment

The project is promising and more thoughtful than many early trading stacks, but it is not yet fully audit-clean from a product-correctness perspective.

If I had to summarize the current state in one sentence:

- the listing path is relatively mature, but the offer path, queued ingestion parity, and cross-currency market-data semantics need immediate attention.
