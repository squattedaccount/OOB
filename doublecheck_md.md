# Double-check items

## 4) Open SDK + abuse management strategy (CORS/API key concern)

Goal:
- Keep SDK usable by anyone while still controlling abusive actors.

Recommendation:
- Keep public read/write access possible.
- Treat API keys as **rate-limit tiering / abuse management**, not ownership/auth.
- Add optional per-key policy controls (tighter write limits, revocation, tagging).
- Keep signature verification as the true authorization boundary for order/cancel actions.

CORS note:
- Open CORS (`*`) with `X-API-Key` allowed can enable browser-based key misuse if keys are embedded in frontend code.
- If keeping open public SDK usage, prefer:
  - public/no-key tier from browser,
  - registered key tier via backend proxy,
  - optional origin allowlist only for key-enabled browser flows.

## 5) API key usage clarification (for follow-up)

`X-API-Key` in this project is used for rate-limit tiering, not auth.

Code signals:
- Header read + key validation for tiering: `packages/api/src/rateLimit.ts`
- CORS allows `X-API-Key`: `packages/api/src/response.ts`
- Write authorization still comes from signatures: `packages/api/src/routes/orders.ts`

Open question:
- Product policy for registered users:
  - Backend-issued key usage only, or
  - limited browser-safe tokens (short-lived, scoped) for direct client use.

7: how should we manage API keys? how user can requre API key?
How to give API keys to registered users
Two models:

Backend-only (recommended for key secrecy)
User calls their backend → backend adds X-API-Key → forwards to your API.
Best security.
Direct browser key (possible, but weaker)
Key is exposed to client and can be copied/abused.
If you do this, use strict limits + quick rotation/revocation.

8. Theoretical question: our SDK is open to anyone, also our APIs. SO anyone can create orders, cancel orders, etc... how should we limit if a malicious user wants to create a lot of "bad" orders? Like valid orders, but with NFSW content, or with invalid content, or with invalid recipients, etc... ? Give recommendations. 

10. potential issue: Stale Data
The agent gets a listing from your cache. But between the time you cached it and the time the agent tries to fill it, the NFT was transferred, the approval was revoked, or the order was filled on another marketplace. 

11. Validation at Read Time (Cheap Insurance)

Even with event-driven invalidation, there's always a small window where your cache might be stale. Consider adding a lightweight validation step to your fill-tx endpoint.

Before returning the calldata, do a quick on-chain check: does the seller still own this token? Is the approval still active? This adds maybe 100-200ms to the fill-tx response but prevents agents from getting transactions that will definitely revert.

should we add this? if yes, can we reduce the 100-200ms ? 

Status: partially implemented.
- `GET /v1/orders/:hash/fill-tx` now supports optional `?validate=true`.
- When `validate=true` and the order is an ERC721 listing, the API performs an on-chain `ownerOf(tokenId)` check via `eth_call` before returning calldata.
- If the seller is not the current owner, the API returns `409` with code `SELLER_NO_LONGER_OWNS`.
- Fail-open: if no RPC URL is configured or the RPC call fails, the API proceeds and returns calldata.

Config (API env):
- `RPC_URL_ETHEREUM`
- `RPC_URL_BASE`
- `RPC_URL_BASE_SEPOLIA`
- `RPC_URL_HYPERLIQUID`
- `RPC_URL_RONIN`
- `RPC_URL_RONIN_TESTNET`
- `RPC_URL_ABSTRACT`

Notes:
- We implemented `ownerOf` only (not approval checks yet). Owner checks are the highest signal / lowest complexity.

12. Analytics / Observability for You
This isn't agent-facing, but you need to know:

How many orders are being served from cache vs hitting Neon?
What's your cache hit rate?
How many fill-tx requests result in successful on-chain transactions?
How many orders in your system are actually stale?
What's the average time between an on-chain event and your cache update?

should we add these? 

15. 
Pub/Sub Channels for Real-Time Updates
The Problem:
Polling is inefficient. If you have 1,000 agents polling best-listing every 2 seconds, you are burning money on Cloudflare and Redis reads.

The Redis Solution:
Use Upstash Redis Pub/Sub.

The Trigger: When your Ingestion Worker (from point #1) writes a new listing to Neon, it also publishes a message to a Redis Channel: events:new_listing.
The Delivery: Your Cloudflare Worker can expose a WebSocket or SSE (Server-Sent Events) endpoint that subscribes to this Redis channel.
The Result: Agents connect once. When a listing happens, Redis pushes it to the Worker, which pushes it to the Agent.

is this real problem or we already handle this? any recommendation related to this? 

16. Should anonymous users be able to submit orders at all, or require even a free registered key? - I THINK YES. 


17. 

here i asked an agent how our webstocket stuff works: 

"On WebSocket — how it works / how we track subscriptions:

There is no DB tracking at all. When agent A connects and says "watch collection 3 and 5", that filter lives purely in Durable Object memory as a Map<WebSocket → filter>. The moment the connection drops, it's gone. No persistence, no record of who was watching what. The DO just applies the filter when broadcasting — if an order event comes in for collection 3, it checks each connected session and only sends it to sessions whose filter includes collection 3.

What else agents can use WebSocket for: real-time floor price monitoring without polling, arbitrage signals (new cheap listing → instant notification), watching counter-offers on collections they're market-making in, live UI feeds for marketplace frontends.

The current gap: the 100-collection limit is per-connection, not per-key. An agent can open 10 connections × 100 collections = 1,000 collections watched with no restriction. The tier system closes this with a total collections watched across all connections per key limit. "

as i understand it, it works only when an user is tracking our events... whilte they do it, he can get real time info... but in my head, this should be like a service where agetn can subscirbe to a collection, and get notificaton everytime when something happens in the collection, like new NFT listed, etc. also we should figure it out tier limits, and API tiers, and consider this to add as some paid feature. 

18. we should see our botlenecks, costs, limits etc. to design and scale projcet properly and adjust limits. we caretead a docs: /Users/oob/docs/business-infrastructure-analysis.md but I'm not sure how accurate it is. 


