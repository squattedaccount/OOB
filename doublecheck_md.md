# Double-check items

## 2) Seaport v1.6 fee funding model (needs deeper verification)

Question to verify with protocol-level certainty:
- In our offer flow, are fee consideration items funded from the offerer's offered ERC20 amount during fulfillment, or can they require separate seller-side ERC20 funding in some edge path?

Context in code:
- Offer creation puts ERC20 in `offer[]`: `packages/sdk/src/seaport.ts` (`createOffer`)
- Fees are put in `consideration[]`: `packages/sdk/src/seaport.ts` (`createOffer`)
- Current SDK `fillOrder` offer path performs seller-side ERC20 readiness checks for non-self consideration recipients: `packages/sdk/src/client.ts`

Action:
- Validate against Seaport v1.6 execution semantics and contract tests; then decide whether to remove/keep/feature-flag seller ERC20 readiness checks.

## 3) Fee/BPS safety hardening (recommended implementation)

Recommended guards (API + SDK):
1. Require all BPS values to be finite integers in `[0, 10000]`.
2. In listing creation, enforce total deductions bound:
   - `protocolFeeBps + marketplaceFeeBps + royaltyBps <= 10000`.
3. Fail fast with explicit errors before signing/submitting.
4. Reject malformed env fee config (`PROTOCOL_FEE_BPS`) at request time.

Why:
- Prevent impossible payout math and misconfiguration-driven runtime failures.

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

## 6) Chain ID validation consistency

Status: implemented.
- Added strict `isValidChainId` checks in:
  - `GET /v1/orders/best-listing`
  - `GET /v1/orders/best-offer`
  - `GET /v1/collections/:address/stats`



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

