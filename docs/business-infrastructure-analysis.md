# OOB — Business & Infrastructure Analysis

> February 2026. Two customer types: **Agents** (bots/AI that trade) and **Marketplaces** (products built on the SDK). Both use the same API and tier system.

---

## 1. Third-Party Services & Cost Thresholds

| Service | Role | Free limit | First paid tier |
|---|---|---|---|
| **Neon Postgres** | Orders DB, activity log, webhook dedup | 0.5 GB, auto-suspends after 5 min idle | $19/mo (Launch) — no suspend, 10 GB |
| **Cloudflare Workers** | API + Indexer runtime | 100k req/day, 10ms CPU/req | $5/mo — 10M req/day, 30ms CPU/req |
| **Cloudflare Durable Objects** | WebSocket sessions | 1M req/mo free | Included in Workers Paid |
| **Upstash Redis** | Cache, rate limiting, locks | **10k commands/day** | $0.20/100k commands (PAYG) |
| **Alchemy / RPC** | Multicall3 stale checks, webhook delivery | 300M CU/mo (unlimited for our pattern) | $49/mo Growth |

**Priority upgrades:**
1. **Upstash** — 10k/day free breaks at ~2–5k API requests/day (2–6 Redis calls per request). First thing to upgrade.
2. **Neon** — auto-suspend = 500ms cold start. $19/mo Launch removes it and covers ~5M orders.
3. **Cloudflare Workers** — $5/mo paid plan needed for 30ms CPU budget (EIP-712 + DB write is tight in 10ms).

**Monthly infra cost at scale:**

| Traffic | Neon | CF | Upstash | RPC | Total |
|---|---|---|---|---|---|
| Dev (<1k req/day) | Free | Free | Free | Free | **$0** |
| Early (~10k req/day) | $19 | $5 | ~$5 | Free | **~$29** |
| Growth (~100k req/day) | $69 | $5 | ~$50 | $49 | **~$173** |
| Scale (~1M req/day) | $700+ | $50+ | $280 | $199+ | **~$1,230+** |

50 paying customers at $49/mo avg = $2,450 MRR vs ~$173 infra at Growth traffic. Healthy. Protocol fee (0.5% of all fills) is the larger revenue stream as volume grows.

---

## 2. How WebSocket Works

An agent opens a connection to `wss://api.oob.xyz/v1/stream?chainId=8453&collection=0x...`. This routes to a **Durable Object** (DO) instance — one per `chainId:collection` room. The DO holds a `Map<WebSocket → {events, chainIds, collections}>` **purely in memory**. There is no DB tracking of who is subscribed to what. When the connection drops, the session is gone.

When any order mutation happens (submit/cancel/fill), the API worker broadcasts the event to the relevant DO room. The DO applies each session's filter server-side and only forwards matching events.

**What agents use WebSocket for:**
- Real-time floor price changes — react to a new cheap listing without polling
- Arbitrage signals — new listing below market triggers immediate action
- Portfolio/market-making — watch collections they hold or make markets in
- Live UI updates (marketplaces) — real-time order book feed for frontends

**Current filter limits per connection (`stream.ts`):**
- Max 20 event types
- Max 20 chainIds
- Max 100 collections

**The gap:** an agent can open *multiple* connections, each with 100 collections — so there is currently no effective upper bound on total collections watched per key. This is the dimension to tier.

---

## 3. Current Hard Limits (from code)

| Dimension | Current limit |
|---|---|
| Active orders per offerer | 500 |
| Max order duration | 1 year |
| Batch submit / fill / cancel | 20 orders |
| Pagination offset cap | 10,000 rows |
| Page size cap | 100 rows |
| WS collections per connection | 100 |
| Rate limit — public reads/writes | 60 / 10 per min |
| Rate limit — registered reads/writes | 300 / 60 per min |
| Write burst | 5 req/sec (hardcoded) |

**Not limited today:**
- Collections a key can submit orders for (no allowlist)
- Concurrent WebSocket connections per key
- Total collections watched across all WS connections per key
- Chains a key can access

---

## 4. Tier System

**Philosophy:** reads stay free for everyone — the open book value is that anyone can see everything. Writes, WebSocket scale, and premium features are where tiers apply.

### 4.1 Tier Table

| | **Anon** | **Free (key)** | **Starter** | **Growth** | **Pro** | **Enterprise** |
|---|---|---|---|---|---|---|
| **Price** | — | $0 | $9/mo | $49/mo | $199/mo | Custom |
| **Reads/min** | 60 | 300 | 1,000 | 5,000 | 20,000 | Unlimited |
| **Writes/min** | 10 | 60 | 200 | 1,000 | 5,000 | Unlimited |
| **Write burst** | 5/sec | 5/sec | 15/sec | 50/sec | 200/sec | Custom |
| **Collections (write)** | 3 | 3 | 25 | 200 | 2,000 | Unlimited |
| **WS connections** | — | 2 | 10 | 50 | 200 | Unlimited |
| **WS collections (total across all connections)** | — | 10 | 100 | 1,000 | 10,000 | Unlimited |
| **Batch size** | 20 | 20 | 20 | 100 | 500 | 500 |
| **Active orders/offerer** | 500 | 500 | 500 | 2,000 | 10,000 | Custom |
| **Activity history** | 30 days | 30 days | 90 days | 1 year | Full | Full |
| **Stale detection** | Standard | Standard | Standard | Priority | Priority | Dedicated |
| **Analytics API** | ✗ | ✗ | ✗ | ✓ | ✓ | ✓ |
| **Protocol fee** | 0.5% | 0.5% | 0.5% | 0.4% | 0.3% | Negotiated |

> Protocol fee reduction for Growth/Pro creates a direct upgrade incentive tied to trading volume — the more a customer fills, the more they save.

### 4.2 Why Each Limit Costs Us

| Dimension | Our cost driver |
|---|---|
| Write rate | Neon write IOPS + 10 Redis commands per submit |
| Collections (write) | Each active collection consumes stale-check cron slots every 5 min indefinitely |
| WS connections | DO memory (~1 KB/session) + broadcast CPU fan-out |
| WS collections watched | Filter evaluation on every broadcast — large sets slow fan-out |
| Batch size | Larger DB result sets, more Redis invalidation calls per request |
| Activity history depth | Deeper range queries on `order_activity` — slow without partitioning |
| Analytics | Aggregate queries on large tables; expensive without materialized views |
| Priority stale detection | Cron slot allocation — paid collections checked every run, free every N runs |

---

## 5. On the Collection Limit

**Currently:** no per-key limit. Any key or anonymous IP can submit orders for any collection on any chain.

**Why to add it:** one aggressive key submitting orders across 500 junk collections burns stale-check cron slots for all of them, forever. Each active collection is an ongoing operational cost, not a one-time cost.

**What to gate:** only *submitting* orders for a collection. *Reading* the full order book stays free and unlimited — that's the open protocol value prop.

**Collection limit: per-chain or global?** Recommend **global across chains** — simpler to enforce, harder to game (e.g. spreading 5 collections across 7 chains to get 35 effective slots).

---

## 6. Infrastructure Prerequisites for Any Paid Tier

Before you can enforce per-key limits, you need:

1. **DB-backed API key store** — replace the `API_KEYS` env var with an `api_keys` table: `(key_hash, tier, owner_email, created_at)`. This is the foundation for everything else.
2. **`api_key_collections` table** — `(key_hash, nft_contract, chain_id, added_at)`. Checked on every order submit.
3. **`api_key_ws_connections` tracking** — count active WS connections per key in Redis (lightweight `INCR`/`DECR` on connect/disconnect).
4. **Upgrade Neon to Launch ($19/mo)** — eliminates auto-suspend cold starts.
5. **Upgrade Upstash to PAYG** — free tier breaks at ~2–5k API req/day.
6. **Cloudflare Workers Paid ($5/mo)** — needed for 30ms CPU budget on write paths.

---

## 7. Key Decisions Needed From You

1. **Anonymous writes:** Should anonymous users (no API key) be able to submit orders at all, or require a free registered key? Requiring registration — even free — gives an email address and enables per-user enforcement. Current system allows fully anonymous writes.

2. **Collection limit scope:** Per-chain or global? (Recommendation above: global.)

3. **Existing keys:** The current `API_KEYS` env var entries — what tier do they get when migrated to DB? Recommend Pro/unlimited so existing integrations don't break.

4. **Marketplaces vs agents:** Same tier system for both, or separate tracks with different feature emphasis? Argument for same: simpler. Argument for separate: a marketplace cares about collection allowlist + analytics; an agent cares about rate limits + batch size + WebSocket scale.

