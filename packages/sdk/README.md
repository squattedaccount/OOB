# Open Order Book

**A permissionless, public order book for NFT trading.** Built on [Seaport v1.6](https://github.com/ProjectOpenSea/seaport).

Any marketplace, bot, AI agent, or individual can read orders, submit orders, and fill orders. Public reads do not require an API key, while higher-throughput access can use project API keys.

If you are new to the project, start with [../../docs/start-here.md](../../docs/start-here.md). This document is specifically for SDK usage and SDK API surface.

> **Think of it as a shared liquidity layer for NFTs.** Instead of every marketplace having its own isolated order book, the Open Order Book lets everyone share the same pool of buy and sell orders.

## Why?

NFT liquidity is fragmented. If you list on OpenSea, buyers on other platforms can't see it. If you build a new marketplace, you start with zero orders.

The Open Order Book fixes this:
- **Sellers** list once, get exposure everywhere
- **Buyers** see the best prices across all connected marketplaces
- **Marketplaces** launch with instant liquidity — no cold-start problem
- **Bots & AI agents** get clean, fast access to all orders
- **Everyone** benefits from deeper liquidity and tighter spreads

## How It Works

1. A seller signs an off-chain Seaport order (gasless — just a signature)
2. The signed order is submitted to the Open Order Book API
3. Anyone can query the API to discover orders
4. Anyone can fill an order on-chain by sending a transaction to the Seaport contract

Orders are **cryptographically signed** — they can't be tampered with. Fees are **baked into the order** at signing time — they can't be removed. The Seaport smart contract (deployed by OpenSea, audited, immutable) handles all settlement.

## Quick Start

### Option 1: Use the SDK (JavaScript/TypeScript)

```bash
npm install @oob/sdk viem
```

```typescript
import { OpenOrderBook } from '@oob/sdk';

const oob = new OpenOrderBook({ chainId: 8453 }); // Base

// Browse listings — no wallet, no API key
const { orders } = await oob.getOrders({
  collection: '0xYourNftContract',
  type: 'listing',
  sortBy: 'price_asc',
});

// Get the floor price
const cheapest = await oob.getBestListing({
  collection: '0xYourNftContract',
});
console.log('Floor:', cheapest?.priceWei);
```

### Option 2: Use the REST API directly (any language)

```bash
# Get all listings for a collection
curl "https://api.openorderbook.xyz/v1/orders?chainId=8453&collection=0xYourNft&type=listing&sortBy=price_asc"

# Get the cheapest listing
curl "https://api.openorderbook.xyz/v1/orders/best-listing?chainId=8453&collection=0xYourNft"

# Get collection stats (floor, offer count, etc.)
curl "https://api.openorderbook.xyz/v1/collections/0xYourNft/stats?chainId=8453"
```

No SDK needed for public reads — just HTTP. Higher-throughput access can supply an API key.

## Creating Orders (Selling / Offering)

To create orders, you need a wallet to sign with:

```typescript
import { createPublicClient, createWalletClient, http } from 'viem';
import { base } from 'viem/chains';
import { OpenOrderBook } from '@oob/sdk';

const oob = new OpenOrderBook({ chainId: 8453 });

const publicClient = createPublicClient({ chain: base, transport: http() });
const walletClient = createWalletClient({ chain: base, transport: http() });
oob.connect(walletClient, publicClient);

// List an NFT for sale (gasless — just a signature)
const listing = await oob.createListing({
  collection: '0xYourNftContract',
  tokenId: '42',
  priceWei: '1000000000000000000', // 1 ETH
});
console.log('Listed! Order hash:', listing.orderHash);

// Make an open offer on a specific token
const openOffer = await oob.createOffer({
  collection: '0xYourNftContract',
  tokenId: '42',
  amountWei: '500000000000000000', // 0.5 WETH
  currency: '0x4200000000000000000000000000000000000006', // WETH on Base
});

// Make a collection-wide open offer
const collectionOffer = await oob.createOffer({
  collection: '0xYourNftContract',
  amountWei: '300000000000000000',
  currency: '0x4200000000000000000000000000000000000006',
});

// Make a targeted offer when the seller is already known
const targetedOffer = await oob.createTargetedOffer({
  collection: '0xYourNftContract',
  tokenId: '42',
  seller: '0xSellerWalletAddress',
  amountWei: '500000000000000000', // 0.5 WETH
  currency: '0x4200000000000000000000000000000000000006', // WETH on Base
});
```

Use `createOffer()` for buyer-signed open offers that will later be accepted via Seaport's match flow.

Use `createTargetedOffer()` only when the seller is already known and the offer can be accepted via the direct fulfill path.

## Buying / Filling Orders

```typescript
// Buy an NFT (sends on-chain transaction)
const txHash = await oob.fillOrder(listing.orderHash);

// Accept an open offer as the seller (mirror + match flow)
const acceptTxHash = await oob.acceptOpenOffer(openOffer.orderHash, {
  tokenId: '42',
});

// Accept a criteria-based offer as the seller (supply tokenId + Merkle proof)
const acceptCriteriaTxHash = await oob.acceptOpenOffer(collectionOffer.orderHash, {
  tokenId: '42',
  criteriaProof: ['0x...'],
});

// Cancel your listing (on-chain transaction + API notification)
const { txHash: cancelTx } = await oob.cancelOrder(listing.orderHash);
```

`fillOrder()` is for listings and direct targeted offers.

`acceptOpenOffer()` is for open offers created with `createOffer()`.

## For Marketplaces: Add Your Own Fee

If you're building a marketplace or integrator on top of the Open Order Book, you have two fee surfaces:

- configure an optional **origin fee** when creating orders
- add an optional buyer-side fee using Seaport's **tipping mechanism** when filling orders

Buyer-side tip example:

```typescript
const txHash = await oob.fillOrder('0xOrderHash', {
  tip: {
    recipient: '0xYourFeeWallet',
    basisPoints: 100, // 1% additional fee
  },
});
```

The buyer pays: **item price + your marketplace fee (as tip)**.

The OOB protocol fee is embedded in the signed order. Your buyer-side tip is optional app-layer behavior in MVP and can be bypassed by direct fills outside your marketplace flow.

## For Bots & AI Agents

Public access is enough for lightweight usage. For higher sustained throughput, batch-heavy workflows, or plan-gated websocket usage, configure the SDK with a project API key.

### Real-time monitoring via WebSocket

```typescript
const unsub = oob.subscribe(
  { collection: '0x...', events: ['new_listing', 'sale'] },
  (event) => {
    if (event.type === 'new_listing') {
      console.log('New listing at', event.order.priceWei);
      // Your logic: evaluate, snipe, arbitrage, etc.
    }
  },
);

// Stop listening
unsub();
```

### Direct API access (no SDK needed)

```bash
# Submit a pre-signed order (for bots that sign orders themselves)
curl -X POST https://api.openorderbook.xyz/v1/orders \
  -H "Content-Type: application/json" \
  -d '{"chainId": 8453, "order": {...}, "signature": "0x..."}'
```

Python, Rust, Go — any language that can make HTTP requests and sign EIP-712 messages can interact with the Open Order Book.

## Supported Chains

| Chain | Chain ID | Status |
|---|---|---|
| Ethereum | 1 | Supported |
| Base | 8453 | Supported |
| Base Sepolia | 84532 | Testnet |
| Hyperliquid | 999 | Supported |
| Ronin | 2020 | Supported |
| Abstract | 2741 | Supported |

## Documentation

| Document | Audience | Description |
|---|---|---|
| [Start Here](../../docs/start-here.md) | Everyone | Canonical entry point for choosing the right documentation path |
| [API Reference](../../docs/api-reference.md) | Developers, bots | Every endpoint, parameter, and response format |
| [Integration Guide](../../docs/integration-guide.md) | Marketplaces, traders, bots | Step-by-step walkthroughs for common use cases |
| [Architecture](../../docs/architecture.md) | Contributors, self-hosters | How it works under the hood, infrastructure, and self-hosting |

## SDK Reference

### Constructor

```typescript
new OpenOrderBook(config: OobConfig)
```

| Param | Type | Default | Description |
|---|---|---|---|
| `chainId` | `number` | *required* | Chain ID to operate on |
| `apiUrl` | `string` | `https://api.openorderbook.xyz` | API base URL |
| `apiKey` | `string` | — | Optional key for higher rate limits |
| `originFeeBps` | `number` | `0` | Optional origin fee in basis points for marketplace/integrator-created orders |
| `originFeeRecipient` | `string` | — | Required if `originFeeBps > 0` |
| `royaltyPolicy` | `'off' \| 'manual_only' \| 'auto_eip2981'` | `'manual_only'` | Controls whether the SDK ignores royalties, requires explicit royalty inputs, or auto-resolves via EIP-2981 |

### Royalty policy modes

- `manual_only` — no automatic royalty lookup; your marketplace explicitly decides royalty, and if you provide `royaltyRecipient` plus `royaltyBps`, the SDK embeds them into the signed order
- `off` — the SDK does not embed royalties when creating orders
- `auto_eip2981` — if you do not provide explicit royalty fields, the SDK attempts to call `royaltyInfo(tokenId, salePrice)` and embed the returned royalty when available

Explicit royalty params still take precedence over auto-resolution in `auto_eip2981` mode.

`auto_eip2981` only auto-resolves for token-specific listings and token-specific offers. It does not auto-resolve for collection offers, because the final `tokenId` is not known when the order is created.

For collection offers, marketplaces must decide royalty explicitly if they want it embedded in the signed order.

### Read Methods (no wallet needed)

| Method | Returns | Description |
|---|---|---|
| `getOrders(params?)` | `{ orders, total }` | Query orders with filters |
| `getOrder(hash)` | `OobOrder \| null` | Get single order by hash |
| `getBestListing({ collection, tokenId? })` | `OobOrder \| null` | Cheapest active listing |
| `getBestOffer({ collection, tokenId? })` | `OobOrder \| null` | Highest active offer |
| `getListings(collection, opts?)` | `{ orders, total }` | All active listings (sorted by price) |
| `getOffers(collection, opts?)` | `{ orders, total }` | All active offers (sorted by price) |
| `getCollectionStats(collection)` | `CollectionStats` | Floor price, listing/offer counts |

### Write Methods (wallet required)

| Method | Returns | Description |
|---|---|---|
| `connect(walletClient, publicClient)` | `this` | Connect wallet for signing |
| `createListing(params)` | `{ orderHash, status }` | Sign and submit a listing |
| `createOffer(params)` | `{ orderHash, status }` | Sign and submit an open offer |
| `createTargetedOffer(params)` | `{ orderHash, status }` | Sign and submit a direct offer for a known seller |
| `fillOrder(hash, params?)` | `txHash` | Buy a listing or accept a direct targeted offer |
| `acceptOpenOffer(hash, params?)` | `txHash` | Accept an open offer via mirror + match flow |
| `cancelOrder(hash)` | `{ txHash, apiStatus }` | Cancel on-chain + notify API |
| `submitOrder(order, signature, params?)` | `{ orderHash, status }` | Submit a pre-signed order with optional fee/royalty metadata |

### Utility Methods

| Method | Returns | Description |
|---|---|---|
| `isApproved(collection, owner?)` | `boolean` | Check Seaport NFT approval |
| `isReadyToOffer(currency, amount, owner?)` | `{ hasBalance, hasAllowance, ... }` | Check ERC20 readiness |
| `approveCollection(collection)` | `txHash` | Approve Seaport for NFT transfers |
| `approveErc20(token, amount?)` | `txHash` | Approve Seaport for ERC20 spending |
| `getOnChainStatus(hash)` | `{ isValidated, isCancelled, ... }` | Check order status on-chain |

### Real-Time

| Method | Returns | Description |
|---|---|---|
| `subscribe(params, callback)` | `() => void` | WebSocket subscription. Returns unsubscribe function. |

## Fees

The Open Order Book charges a **0.33% protocol fee** (33 basis points) on all orders created through the SDK or API.

- The fee is embedded in the signed order — it cannot be removed or bypassed
- The fee is enforced by the Seaport smart contract at settlement time
- Marketplaces and integrators can optionally add an embedded `originFee` when creating orders
- SDK royalty behavior is controlled by `royaltyPolicy`: `manual_only`, `off`, or `auto_eip2981`
- If royalty is embedded in the signed order, it is non-bypassable everywhere that order is filled
- `submitOrder(..., { metadata })` can explicitly declare `originFee` and `royalty` semantics for pre-signed orders so the API preserves the intended classification
- Third-party marketplaces can optionally add a buyer-side fee on top via the tipping mechanism

## Contributing

The Open Order Book is open source under the MIT license. Contributions are welcome.

```bash
git clone https://github.com/openorderbook/sdk.git
cd sdk
npm install
npm run check    # Type check
npm run build    # Build ESM + CJS
npm run test     # Run tests
```

## License

MIT
