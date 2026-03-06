# Changelog

All notable changes to the `@oob/sdk` package will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - Unreleased

### Added
- **ERC1155 support**: `createListing` and `createOffer` now accept `tokenStandard` and `quantity` params.
- **Input validation**: `createListing` and `createOffer` validate addresses and amounts before signing.
- **Retry/backoff**: API client automatically retries on 429 and 5xx errors with exponential backoff (up to 3 retries).
- **Flexible method signatures**: `getListings()` and `getOffers()` now accept both `(collection, opts?)` and `({ collection, ... })` param styles for consistency with `getOrders()`.
- **Origin fee terminology**: marketplace/integrator fee config is expressed as `originFeeBps` / `originFeeRecipient`.

### Changed
- Nothing yet.

### Fixed
- Nothing yet.

## [0.1.0] - Initial Release

### Added
- `OpenOrderBook` client with wallet connection, order creation, filling, and cancellation.
- `SeaportClient` for EIP-712 order signing and on-chain fulfillment via Seaport v1.6.
- `ApiClient` for REST communication with the OOB API.
- Real-time WebSocket event subscriptions via `subscribe()`.
- Support for Ethereum, Base, Base Sepolia, Hyperliquid, Ronin, and Abstract chains.
- Origin fee configuration for marketplaces and integrators.
- Protocol fee auto-fetching from API (cached 5 min).
- ERC20 readiness checks (allowance + balance) before offer creation.
- Collection approval checks before listing creation.
