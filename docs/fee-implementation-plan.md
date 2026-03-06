# Fee Implementation Plan

## Overview

This document captures the agreed MVP fee model for OOB and the implementation plan to align the current SDK, API, storage schema, and docs.

## Agreed MVP Model

### Protocol Role

- OOB is a neutral rail for marketplaces, bots, AI agents, and direct API users.
- OOB enforces a mandatory protocol fee on every accepted order.
- The protocol fee is embedded in the signed Seaport order and cannot be bypassed after submission.

### Origin Fee

- Marketplaces and integrators may optionally set an `originFee`.
- `originFee` applies to both listings and offers.
- If present, `originFee` is embedded in the signed order and cannot be bypassed.
- Direct/API usage is protocol-only by default, but callers may explicitly supply an `originFee` if they are acting as an originator/integrator.
- MVP supports exactly one `originFeeRecipient`.
- MVP caps `originFeeBps` at `500` (5%).

### Buyer Fee

- Buyer-side marketplace fee is not protocol-enforced in MVP.
- Marketplaces may optionally add a Seaport tip during fill.
- Without a zone, that buyer-side fee remains optional and bypassable.
- Zone-based buyer-fee enforcement is a possible future addition, not part of MVP.

### Royalties

- Royalties are optional by marketplace policy.
- If a marketplace includes royalty in the signed order, that royalty becomes non-bypassable everywhere the order is filled.
- If a marketplace does not include royalty in the signed order, no royalty is enforced by the protocol.
- Submission metadata should explicitly declare royalty and origin-fee semantics so the API does not need to infer them from raw Seaport recipients alone.

## Fee Invariants

### Always enforced

- `protocolFeeBps`
- `protocolFeeRecipient`

### Enforced if present

- `originFeeBps`
- `originFeeRecipient`
- `royaltyBps`
- `royaltyRecipient`

### Optional only

- buyer-side tip
- royalties

## Data Model Direction

The old generic `feeBps` / `feeRecipient` naming is too ambiguous. The system should move to explicit protocol and origin fee semantics.

Submission-time metadata should also carry explicit origin-fee and royalty semantics so ingestion can preserve what the origin marketplace intended.

### Target naming

- `protocolFeeBps`
- `protocolFeeRecipient`
- `originFeeBps`
- `originFeeRecipient`

### MVP storage

The database should store protocol and origin fee fields separately from day one.

## Implementation Scope

### SDK

- Rename marketplace fee config to origin fee terminology.
- Keep direct/API usage protocol-only by default.
- Apply origin fee to both `createListing()` and `createOffer()` when configured.
- Keep optional fill-time tip support for marketplaces.
- Do not add zone or restricted-order logic.

### API

- Keep `/v1/config` protocol-fee-only.
- Enforce only the protocol fee at submission time.
- Parse protocol fee and origin fee separately.
- Accept optional submission metadata for `originFee` and `royalty` semantics.
- Use submission metadata as the source of truth when present, with heuristic fallback only for older callers.

### Storage

- Replace generic fee columns with explicit protocol and origin fee columns.
- Keep royalty columns unchanged, but populate them from explicit submission metadata when present.

### Docs

- Document OOB as neutral rail.
- Document origin fee as optional and non-bypassable once embedded.
- Document buyer tip as optional and bypassable in MVP.
- Document royalties as marketplace-policy-controlled and non-bypassable once embedded in the signed order.

## File-by-File Plan

### `packages/sdk/src/types.ts`

- Rename SDK config fields to `originFeeBps` / `originFeeRecipient`.
- Add `MAX_ORIGIN_FEE_BPS` constant.
- Update `OobOrder` shape to expose protocol and origin fee fields separately.

### `packages/sdk/src/client.ts`

- Validate `originFeeBps` against `MAX_ORIGIN_FEE_BPS`.
- Require `originFeeRecipient` only when `originFeeBps > 0`.
- Update constructor config normalization.
- Keep `fillOrder(..., { tip })` as optional app-layer behavior.

### `packages/sdk/src/seaport.ts`

- Replace marketplace fee terminology with origin fee terminology.
- Apply origin fee to both listings and offers.
- Keep order type as `FULL_OPEN`.
- No zone or zoneHash fee logic.

### `packages/api/src/types.ts`

- Replace `feeRecipient` / `feeBps` in `OrderIngestMessage` with explicit protocol/origin fee fields.
- Update protocol fee default comment from 50 bps to 33 bps.

### `packages/api/src/routes/orders.ts`

- Parse `protocolFee*` and `originFee*` separately.
- Keep protocol fee validation only.
- Add origin fee cap validation for submitted orders.
- Accept explicit submission metadata for origin fee and royalty semantics.
- Return explicit protocol/origin fee fields in API responses.

### `packages/api/src/queue.ts`

- Insert explicit protocol/origin fee fields into the database.

### `packages/api/migrations/001_seaport_orders.sql`

- Replace generic `fee_*` columns with explicit protocol/origin fee columns.
- Set protocol fee default to 33 bps.

## Future Additions

### Buyer-side fee enforcement

Possible future upgrade:

- restricted orders
- Seaport tips as fee mechanism
- zone-based enforcement for mandatory buyer-side fees

This should only be added if OOB decides to enforce buyer-side venue economics at the protocol level.

### Multi-recipient fee splitting

Recommended pre-launch MVP upgrade:

- allow multiple origin fee recipients inside the signed order consideration array
- require explicit metadata describing each origin fee split recipient and basis points
- keep the existing single-recipient fields as aggregate / legacy compatibility fields in API responses during rollout
- add richer storage for the full origin fee split breakdown instead of relying on a single recipient column as the source of truth

Recommended constraints for MVP safety:

- origin fee splits must be explicit, never inferred heuristically
- total origin fee across all split recipients must remain capped at `MAX_ORIGIN_FEE_BPS`
- all split recipients must use the same payment currency already used by the order
- no overlap between protocol fee recipient and origin fee split recipients
- preserve backward compatibility for existing single-recipient callers

Primary use cases:

- referral splits
- affiliate payouts
- white-label marketplace revenue sharing
- sub-account / partner marketplace sharing

### Royalty expansion

Possible future upgrade:

- better handling of collection offers and multi-recipient royalties

Implemented now:

- SDK `royaltyPolicy` config with `off`, `manual_only`, and `auto_eip2981`
- explicit submission metadata for `royaltyRecipient` / `royaltyBps`
- explicit submission metadata for `originFeeRecipient` / `originFeeBps`
- EIP-2981 auto-resolution for SDK-created token-specific orders when `royaltyPolicy = auto_eip2981`
- explicit marketplace-controlled handling for collection-offer royalties, since token-level EIP-2981 auto-resolution is not safely knowable at order-creation time

## Rollout Sequence

### Step 1

- Align SDK config and order construction semantics.

### Step 2

- Align API parsing, responses, and storage semantics.

### Step 3

- Update public docs and examples.

### Step 4

- Revisit royalties and optional future zone enforcement later.
