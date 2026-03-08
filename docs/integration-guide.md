# Integration Guide

This guide walks through common integration scenarios for the Open Order Book. Pick the section that matches your use case.

---

## Table of Contents

- [For NFT Traders](#for-nft-traders)
- [For Marketplace Builders](#for-marketplace-builders)
- [For Trading Bots](#for-trading-bots)
- [For AI Agents](#for-ai-agents)
- [Understanding Fees](#understanding-fees)
- [Understanding Order Lifecycle](#understanding-order-lifecycle)
- [Common Patterns](#common-patterns)

---

## For NFT Traders

You do not need to be technical to benefit from the Open Order Book. Here is what it means for you:

### What happens when you list on a connected marketplace

1. You click "List" on a marketplace that uses the Open Order Book (e.g., nodz.space)
2. Your wallet asks you to sign a message — this is **free**, no gas
3. Your listing appears on **every** marketplace connected to the Open Order Book
4. When someone buys your NFT (from any connected marketplace), the trade settles on-chain

### What are the fees?

- **0.33% protocol fee** — taken from the sale price, embedded in your signed order
- **Origin fee** — an optional fee set by the marketplace or integrator that created the order, embedded in the signed order if present
- **Marketplace buyer fee** — the marketplace where the buyer clicks "Buy" may add their own fee as a tip (paid by the buyer, doesn't reduce your earnings)
- **Creator royalty** — if the marketplace supports it, royalties are also embedded in the order

### Can I cancel my listing?

Yes. Cancellation requires a small gas transaction to the Seaport contract. This invalidates the signed order so it can never be filled.

### Is it safe?

- Your NFT never leaves your wallet until someone actually buys it
- The signed order can only be used to execute the exact trade you agreed to (specific NFT, specific price, specific fees)
- The Seaport smart contract is deployed by OpenSea, audited by multiple firms, and is immutable (can't be changed)

If your listed NFT moves out of your wallet, the indexer marks that listing as `stale` so buyers won't see it as active.

---

## For Marketplace Builders

The Open Order Book gives you instant liquidity. Instead of starting with an empty order book, you launch with every order from every connected marketplace.

**Access note:** public reads work without a key. If you need higher sustained throughput, larger batch limits, or plan-gated websocket access, use a DB-backed project API key from the subscription/dashboard flow.

### Step 1: Display orders (read-only)

No SDK needed — just call the API:

```typescript
// Fetch listings for a collection page
const res = await fetch(
  'https://api.openorderbook.xyz/v1/orders?chainId=8453&collection=0xYourNft&type=listing&sortBy=price_asc&limit=20'
);
const { orders, total } = await res.json();

// Display floor price
const floor = orders[0]?.priceWei; // cheapest listing
```

Or use the SDK for a cleaner DX:

```typescript
import { OpenOrderBook } from '@oob/sdk';

const oob = new OpenOrderBook({ chainId: 8453 });
const { orders } = await oob.getListings('0xYourNft', { limit: 20 });
const stats = await oob.getCollectionStats('0xYourNft');
console.log('Floor:', stats.floorPriceWei);
console.log('Active listings:', stats.listingCount);
```

### Step 2: Enable buying

When a user clicks "Buy" on your marketplace:

```typescript
import { OpenOrderBook } from '@oob/sdk';
import { createPublicClient, createWalletClient, custom } from 'viem';
import { base } from 'viem/chains';

const oob = new OpenOrderBook({ chainId: 8453 });

// Connect the buyer's wallet (e.g., from wagmi, RainbowKit, etc.)
const publicClient = createPublicClient({ chain: base, transport: custom(window.ethereum) });
const walletClient = createWalletClient({ chain: base, transport: custom(window.ethereum) });
oob.connect(walletClient, publicClient);

// Fill the order — this sends an on-chain transaction
const txHash = await oob.fillOrder(orderHash);
```

### Step 3: Add your marketplace fee

You can earn money in two ways:

- add an embedded `originFee` when your marketplace creates the order
- add a tip when your users fill orders through your marketplace UI

Buyer-side tip example:

```typescript
const txHash = await oob.fillOrder(orderHash, {
  tip: {
    recipient: '0xYourFeeWallet',  // your treasury
    basisPoints: 100,               // 1% fee
  },
});
```

**How it works technically:**
- The original order has the OOB protocol fee (0.33%) baked in
- Your tip is added as an extra `consideration` item at fill time
- The buyer pays: item price + your 1% tip
- Seaport settles everything in one atomic transaction
- If any part fails, the entire transaction reverts — no partial fills

**Fee example for a 1 ETH listing:**

| Recipient | Amount | Source |
|---|---|---|
| Seller | 0.9967 ETH | From the signed order |
| OOB Protocol | 0.0033 ETH (0.33%) | From the signed order |
| Your Marketplace | 0.01 ETH (1%) | Tip added at fill time |
| **Buyer pays** | **1.01 ETH** | Total |

### Step 4: Enable listing

Let your users create listings that go into the shared order book:

```typescript
// Check if user has approved Seaport for this collection
const approved = await oob.isApproved('0xNftContract');

if (!approved) {
  // One-time approval transaction (per collection)
  const approvalTx = await oob.approveCollection('0xNftContract');
  // Wait for confirmation...
}

// Create the listing (gasless signature)
const result = await oob.createListing({
  collection: '0xNftContract',
  tokenId: '42',
  priceWei: '1000000000000000000', // 1 ETH
});

console.log('Order hash:', result.orderHash);
// This listing is now visible on ALL connected marketplaces
```

### Step 5: Enable offers

```typescript
// Check if user has WETH balance and Seaport approval
const readiness = await oob.isReadyToOffer(
  '0x4200000000000000000000000000000000000006', // WETH on Base
  '500000000000000000', // 0.5 WETH
);

if (readiness.needsApproval) {
  await oob.approveErc20('0x4200000000000000000000000000000000000006');
}

if (!readiness.hasBalance) {
  // Show "Insufficient WETH balance" message
  return;
}

const result = await oob.createOffer({
  collection: '0xNftContract',
  tokenId: '42',
  amountWei: '500000000000000000',
  currency: '0x4200000000000000000000000000000000000006',
});
```

---

## For Trading Bots

The Open Order Book is designed for bot access. No API keys are needed for public reads, and writes stay available without registration, but higher-throughput automation is better served by a project API key.

### Simple floor sweeper (TypeScript)

```typescript
import { OpenOrderBook } from '@oob/sdk';
import { createPublicClient, createWalletClient, http } from 'viem';
import { base } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';

const account = privateKeyToAccount('0xYOUR_PRIVATE_KEY');
const publicClient = createPublicClient({ chain: base, transport: http() });
const walletClient = createWalletClient({
  chain: base,
  transport: http(),
  account,
});

const oob = new OpenOrderBook({ chainId: 8453 });
oob.connect(walletClient, publicClient);

// Get cheapest listing
const listing = await oob.getBestListing({
  collection: '0xTargetCollection',
});

if (listing && BigInt(listing.priceWei) < BigInt('500000000000000000')) {
  // Floor is under 0.5 ETH — buy it
  const txHash = await oob.fillOrder(listing.orderHash);
  console.log('Bought!', txHash);
}
```

### Real-time sniper with WebSocket

```typescript
const oob = new OpenOrderBook({ chainId: 8453 });
oob.connect(walletClient, publicClient);

const unsub = oob.subscribe(
  {
    collection: '0xTargetCollection',
    events: ['new_listing'],
  },
  async (event) => {
    const price = BigInt(event.order.priceWei);
    const maxPrice = BigInt('500000000000000000'); // 0.5 ETH

    if (price <= maxPrice) {
      try {
        const txHash = await oob.fillOrder(event.order.orderHash);
        console.log(`Sniped ${event.order.tokenId} for ${price} wei! TX: ${txHash}`);
      } catch (err) {
        console.error('Fill failed (likely already sold):', err);
      }
    }
  },
);
```

### Direct API access (no SDK, any language)

**Python example:**

```python
import requests
import json

API = "https://api.openorderbook.xyz"

# Get cheapest listing
resp = requests.get(f"{API}/v1/orders/best-listing", params={
    "chainId": 8453,
    "collection": "0xYourNft",
})
order = resp.json()["order"]

if order:
    print(f"Floor: {order['priceWei']} wei by {order['offerer']}")
    print(f"Order JSON for filling: {json.dumps(order['orderJson'])}")
    # Use web3.py or similar to call Seaport.fulfillOrder() with the orderJson + signature
```

**curl example:**

```bash
# Poll for new listings every 5 seconds
while true; do
  curl -s "https://api.openorderbook.xyz/v1/orders?chainId=8453&collection=0xYourNft&type=listing&sortBy=price_asc&limit=5" | jq '.orders[] | {hash: .orderHash, price: .priceWei, token: .tokenId}'
  sleep 5
done
```

### Rate limits for bots

| Tier | Reads/min | Writes/min | How to get |
|---|---|---|---|
| Public | 60 | 10 | Default, no key needed |
| Legacy registered | 300 | 60 | Legacy `API_KEYS` fallback |
| Project key | Plan-defined | Plan-defined | Create a project and API key via wallet auth + subscription flow |

For high-frequency bots, we recommend using WebSocket instead of polling to stay within rate limits and get faster updates. For DB-backed projects, websocket access and batch size are plan-controlled entitlements and monthly project quotas may also apply.

---

## For AI Agents

AI agents (LangChain, AutoGPT, custom agents) can interact with the Open Order Book via the REST API.

For heavier agent traffic, provision a project API key instead of relying only on public IP-based limits.

### Tool definition for LangChain / function calling

```json
{
  "name": "get_nft_listings",
  "description": "Get active NFT listings from the Open Order Book. Returns price, seller, and order details.",
  "parameters": {
    "type": "object",
    "properties": {
      "chain_id": { "type": "number", "description": "Blockchain chain ID (8453 for Base, 1 for Ethereum)" },
      "collection": { "type": "string", "description": "NFT contract address" },
      "sort_by": { "type": "string", "enum": ["price_asc", "price_desc"], "description": "Sort order" },
      "limit": { "type": "number", "description": "Max results (1-100)" }
    },
    "required": ["chain_id", "collection"]
  }
}
```

### Agent workflow example

1. Agent calls `GET /v1/orders?chainId=8453&collection=0x...&type=listing&sortBy=price_asc&limit=5`
2. Agent evaluates: "The floor is 0.3 ETH, user's budget is 0.5 ETH — good deal"
3. Agent constructs and signs a Seaport `fulfillOrder` transaction
4. Agent submits the transaction to the blockchain

The API returns all data needed for on-chain execution in the `orderJson` and `signature` fields.

---

## Understanding Fees

### Protocol fee (0.33%)

The Open Order Book charges 0.33% (33 basis points) on every order. This fee is:

- **Embedded in the signed order** — it's part of the `consideration` array
- **Enforced by the Seaport smart contract** — cannot be bypassed
- **Paid by the seller** (deducted from the sale price for listings) or **paid from the offer amount** (for offers)

### Origin fee (optional)

Marketplaces and integrators can optionally embed an `originFee` when they create an order. This fee is:

- **Embedded in the signed order** — becomes non-bypassable once the order is signed
- **Paid on every fill** — whether the order is filled on a marketplace or directly via API
- **Set by the originator** — OOB does not require it by default

### Marketplace tip (variable)

Third-party marketplaces can add their own fee when filling orders. This is implemented via Seaport's tipping mechanism:

- **Added at fill time** — not part of the original signed order
- **Paid by the buyer** — on top of the listing price
- **Optional in MVP** — direct/API fills can bypass it
- **Enforced by Seaport** — atomic, all-or-nothing

### Creator royalties (optional)

Marketplaces decide whether to include royalties when they create an order.

- If royalty is included in the signed order, it is embedded in the order's `consideration` array and becomes non-bypassable on every fill.
- That means the royalty still applies if the order is filled on another marketplace, via direct API flow, or via a direct Seaport call.
- If royalty is not included at order-creation time, OOB does not enforce it later.
- `auto_eip2981` only auto-resolves for token-specific orders, because EIP-2981 requires a concrete `tokenId` and sale price.
- A collection offer does not target one specific NFT. It is an offer to buy any token from a collection that matches the order criteria, so the final `tokenId` is only known when a seller accepts it.
- Because of that, marketplaces must decide royalty explicitly for collection offers if they want royalty embedded in the signed order.

### Collection offers and royalties

For token-specific listings and token-specific offers, a marketplace can use `royaltyPolicy = auto_eip2981` and let the SDK resolve royalty automatically when no explicit royalty is supplied.

For collection offers, the marketplace has to choose one of these approaches:

- embed no royalty
- embed an explicit royalty chosen by the marketplace
- avoid collection offers when exact token-level royalty enforcement is required

OOB does not guess token-level royalties for collection offers, because that would be non-canonical and could be wrong for the token that is ultimately used to fill the order.

### Fee flow diagram

```
Listing: 1 ETH

Seller signs order with consideration:
  → 0.9967 ETH to Seller
  → 0.0033 ETH to OOB Protocol (0.33%)

Buyer fills on Marketplace X (1% tip):
  → Pays 1.01 ETH total
  → 0.9967 ETH → Seller
  → 0.0033 ETH → OOB Protocol
  → 0.01 ETH  → Marketplace X
```

---

## Understanding Order Lifecycle

```
Created (signed)
    │
    ├── Active ──── Filled (on-chain purchase)
    │                  └── filledTxHash, filledAt set
    │
    ├── Active ──── Cancelled (on-chain cancel tx)
    │                  └── cancelledTxHash, cancelledAt set
    │
    ├── Active ──── Expired (endTime passed)
    │
    └── Active ──── Stale (lister no longer owns the NFT)
```

**Status definitions:**

| Status | Meaning |
|---|---|
| `active` | Order is valid and can be filled |
| `filled` | Order was successfully filled on-chain |
| `cancelled` | Order was cancelled via on-chain transaction |
| `expired` | Order's `endTime` has passed |
| `stale` | Listing is no longer fillable because ownership no longer matches the lister (detected by transfer webhooks + cron backstop) |

---

## Common Patterns

### Pagination

```typescript
let offset = 0;
const limit = 50;
let allOrders = [];

while (true) {
  const { orders, total } = await oob.getOrders({
    collection: '0x...',
    type: 'listing',
    limit,
    offset,
  });

  allOrders.push(...orders);

  if (allOrders.length >= total || orders.length === 0) break;
  offset += limit;
}
```

### Error handling

```typescript
import { OpenOrderBook, NeedsApprovalError, InsufficientBalanceError } from '@oob/sdk';
import { OobApiError } from '@oob/sdk';

try {
  await oob.createListing({ ... });
} catch (err) {
  if (err instanceof NeedsApprovalError) {
    // User needs to approve Seaport first
    if (err.approvalType === 'collection') {
      await oob.approveCollection(err.tokenAddress);
      // Retry createListing...
    }
  } else if (err instanceof InsufficientBalanceError) {
    console.log(`Need ${err.required}, have ${err.balance}`);
  } else if (err instanceof OobApiError) {
    console.log(`API error ${err.status}: ${err.message}`);
  }
}
```

### Check before listing (full flow)

```typescript
async function listNft(collection: string, tokenId: string, priceEth: string) {
  const priceWei = BigInt(parseFloat(priceEth) * 1e18);

  // 1. Check approval
  const approved = await oob.isApproved(collection);
  if (!approved) {
    console.log('Approving Seaport for this collection...');
    const tx = await oob.approveCollection(collection);
    console.log('Approval tx:', tx);
    // Wait for confirmation in your app
  }

  // 2. Create listing
  const result = await oob.createListing({
    collection,
    tokenId,
    priceWei: priceWei.toString(),
  });

  console.log('Listed!', result.orderHash);
  return result;
}
```

### Check before offering (full flow)

```typescript
async function makeOffer(collection: string, tokenId: string, amountEth: string, wethAddress: string) {
  const amountWei = BigInt(parseFloat(amountEth) * 1e18);

  // 1. Check WETH balance and approval
  const readiness = await oob.isReadyToOffer(wethAddress, amountWei);

  if (!readiness.hasBalance) {
    throw new Error(`Insufficient WETH. Have: ${readiness.balance}, need: ${amountWei}`);
  }

  if (readiness.needsApproval) {
    console.log('Approving WETH for Seaport...');
    await oob.approveErc20(wethAddress);
  }

  // 2. Create offer
  const result = await oob.createOffer({
    collection,
    tokenId,
    amountWei: amountWei.toString(),
    currency: wethAddress,
  });

  console.log('Offer placed!', result.orderHash);
  return result;
}
```
