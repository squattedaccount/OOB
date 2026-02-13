# API Reference

Base URL: `https://api.openorderbook.xyz`

All read endpoints are public — no API key required. Write endpoints (POST, DELETE) are also open but subject to rate limits.

---

## Authentication

| Tier | How | Read Limit | Write Limit |
|---|---|---|---|
| **Public** | No header needed | 60 req/min | 10 req/min |
| **Registered** | `X-API-Key: your-key` header | 300 req/min | 60 req/min |
| **Premium** | `X-API-Key: your-key` header | 1000+ req/min | 200+ req/min |

Rate limits are per IP (public) or per API key (registered/premium). When exceeded, the API returns `429 Too Many Requests`.

API keys are free to request. Premium keys are available for high-volume integrators.

---

## Endpoints

### GET /v1/orders

Query orders with filters. Returns paginated results.

**Parameters** (all query string):

| Param | Type | Required | Default | Description |
|---|---|---|---|---|
| `chainId` | number | **yes** | — | Chain ID (1, 8453, 84532, 999, 2020, 2741) |
| `collection` | string | no | — | NFT contract address (lowercased) |
| `tokenId` | string | no | — | Specific token ID |
| `type` | string | no | — | `listing` or `offer` |
| `offerer` | string | no | — | Filter by order creator address |
| `status` | string | no | `active` | `active`, `filled`, `cancelled`, `expired`, `stale` |
| `sortBy` | string | no | `created_at_desc` | `created_at_desc`, `price_asc`, `price_desc` |
| `limit` | number | no | 50 | Max results (1–100) |
| `offset` | number | no | 0 | Pagination offset |

**Response:**

```json
{
  "orders": [
    {
      "orderHash": "0xabc123...",
      "chainId": 8453,
      "orderType": "listing",
      "offerer": "0x1234...abcd",
      "nftContract": "0xnft...addr",
      "tokenId": "42",
      "tokenStandard": "ERC721",
      "priceWei": "1000000000000000000",
      "currency": "0x0000000000000000000000000000000000000000",
      "feeRecipient": "0x0000000000000000000000000000000000000001",
      "feeBps": 50,
      "royaltyRecipient": "0xartist...addr",
      "royaltyBps": 500,
      "startTime": 1707840000,
      "endTime": 1710432000,
      "status": "active",
      "createdAt": "2025-02-13T15:00:00.000Z",
      "filledTxHash": null,
      "filledAt": null,
      "cancelledTxHash": null,
      "cancelledAt": null,
      "orderJson": { ... },
      "signature": "0xsig..."
    }
  ],
  "total": 127
}
```

**Example:**

```bash
# All active listings for a collection, cheapest first
curl "https://api.openorderbook.xyz/v1/orders?chainId=8453&collection=0xnft&type=listing&sortBy=price_asc&limit=20"

# All offers from a specific wallet
curl "https://api.openorderbook.xyz/v1/orders?chainId=8453&offerer=0x1234&type=offer"
```

---

### GET /v1/orders/:hash

Get a single order by its hash.

**Parameters:**

| Param | Type | Required | Description |
|---|---|---|---|
| `hash` | string (path) | **yes** | The order hash |

**Response:**

```json
{
  "order": {
    "orderHash": "0xabc123...",
    "chainId": 8453,
    ...
  }
}
```

Returns `404` if the order doesn't exist.

---

### GET /v1/orders/best-listing

Get the cheapest active listing for a collection or specific token.

**Parameters:**

| Param | Type | Required | Description |
|---|---|---|---|
| `chainId` | number | **yes** | Chain ID |
| `collection` | string | **yes** | NFT contract address |
| `tokenId` | string | no | Specific token ID (omit for collection floor) |

**Response:**

```json
{
  "order": {
    "orderHash": "0xabc123...",
    "priceWei": "500000000000000000",
    ...
  }
}
```

Returns `{ "order": null }` if no active listings exist.

---

### GET /v1/orders/best-offer

Get the highest active offer for a collection or specific token.

**Parameters:**

| Param | Type | Required | Description |
|---|---|---|---|
| `chainId` | number | **yes** | Chain ID |
| `collection` | string | **yes** | NFT contract address |
| `tokenId` | string | no | Specific token ID (omit for collection-wide best offer) |

**Response:**

```json
{
  "order": {
    "orderHash": "0xdef456...",
    "priceWei": "400000000000000000",
    "orderType": "offer",
    ...
  }
}
```

Returns `{ "order": null }` if no active offers exist.

---

### GET /v1/collections/:address/stats

Get aggregate statistics for a collection.

**Parameters:**

| Param | Type | Required | Description |
|---|---|---|---|
| `address` | string (path) | **yes** | NFT contract address |
| `chainId` | number (query) | **yes** | Chain ID |

**Response:**

```json
{
  "collection": "0xnft...addr",
  "chainId": 8453,
  "listingCount": 42,
  "floorPriceWei": "500000000000000000",
  "offerCount": 15,
  "bestOfferWei": "400000000000000000"
}
```

---

### POST /v1/orders

Submit a signed Seaport order to the order book.

**Request body:**

```json
{
  "chainId": 8453,
  "order": {
    "offerer": "0x1234...abcd",
    "zone": "0x0000000000000000000000000000000000000000",
    "offer": [
      {
        "itemType": 2,
        "token": "0xnft...addr",
        "identifierOrCriteria": "42",
        "startAmount": "1",
        "endAmount": "1"
      }
    ],
    "consideration": [
      {
        "itemType": 0,
        "token": "0x0000000000000000000000000000000000000000",
        "identifierOrCriteria": "0",
        "startAmount": "995000000000000000",
        "endAmount": "995000000000000000",
        "recipient": "0x1234...abcd"
      },
      {
        "itemType": 0,
        "token": "0x0000000000000000000000000000000000000000",
        "identifierOrCriteria": "0",
        "startAmount": "5000000000000000",
        "endAmount": "5000000000000000",
        "recipient": "0x0000000000000000000000000000000000000001"
      }
    ],
    "orderType": 0,
    "startTime": "1707840000",
    "endTime": "1710432000",
    "zoneHash": "0x0000000000000000000000000000000000000000000000000000000000000000",
    "salt": "12345678901234567890",
    "conduitKey": "0x0000000000000000000000000000000000000000000000000000000000000000",
    "counter": "0"
  },
  "signature": "0xsig..."
}
```

**Response (201):**

```json
{
  "orderHash": "0xabc123...",
  "status": "active"
}
```

**Response (duplicate):**

```json
{
  "orderHash": "0xabc123...",
  "status": "active",
  "duplicate": true
}
```

**Validation rules:**
- `chainId` must be a supported chain
- `order` must contain an NFT in either `offer` (listing) or `consideration` (offer)
- `endTime` must be in the future
- `offerer` must be present
- `signature` must be a valid hex string

---

### DELETE /v1/orders/:hash

Mark an order as cancelled. Typically called after the on-chain `cancel()` transaction.

**Parameters:**

| Param | Type | Required | Description |
|---|---|---|---|
| `hash` | string (path) | **yes** | The order hash |

**Request body (optional):**

```json
{
  "txHash": "0xtx..."
}
```

**Response:**

```json
{
  "orderHash": "0xabc123...",
  "status": "cancelled"
}
```

Returns `404` if the order doesn't exist or is already cancelled/filled.

---

### GET /health

Health check endpoint.

**Response:**

```json
{
  "status": "healthy",
  "service": "oob-api"
}
```

---

## WebSocket: /v1/stream

Real-time order events via WebSocket connection.

**Connection:**

```
wss://api.openorderbook.xyz/v1/stream?chainId=8453&collection=0xnft&events=new_listing,sale
```

**Parameters:**

| Param | Type | Required | Description |
|---|---|---|---|
| `chainId` | number | **yes** | Chain ID |
| `collection` | string | no | Filter by collection (omit for all) |
| `events` | string | no | Comma-separated event types to subscribe to |

**Event types:**

| Event | Description |
|---|---|
| `new_listing` | A new listing was submitted |
| `new_offer` | A new offer was submitted |
| `sale` | An order was filled on-chain |
| `cancellation` | An order was cancelled |
| `price_change` | A listing price was updated (old cancelled, new created) |

**Message format:**

```json
{
  "type": "new_listing",
  "order": {
    "orderHash": "0xabc123...",
    "chainId": 8453,
    "orderType": "listing",
    "priceWei": "1000000000000000000",
    ...
  },
  "timestamp": 1707840000
}
```

---

## Error Responses

All errors follow this format:

```json
{
  "error": "Human-readable error message"
}
```

| Status | Meaning |
|---|---|
| 400 | Bad request (missing params, invalid data) |
| 404 | Order not found |
| 405 | Method not allowed |
| 429 | Rate limit exceeded |
| 500 | Internal server error |

---

## CORS

All endpoints support CORS with `Access-Control-Allow-Origin: *`. You can call the API directly from browser JavaScript.

---

## Order Object Reference

Every order returned by the API has this shape:

| Field | Type | Description |
|---|---|---|
| `orderHash` | string | Unique identifier (keccak256 hash) |
| `chainId` | number | Chain the order is on |
| `orderType` | string | `listing` or `offer` |
| `offerer` | string | Address that created the order |
| `nftContract` | string | NFT contract address |
| `tokenId` | string | Token ID |
| `tokenStandard` | string | `ERC721` or `ERC1155` |
| `priceWei` | string | Total price in wei (as string for precision) |
| `currency` | string | Payment token address (`0x000...000` = native ETH) |
| `feeRecipient` | string | Address receiving the protocol fee |
| `feeBps` | number | Protocol fee in basis points |
| `royaltyRecipient` | string \| null | Royalty recipient address |
| `royaltyBps` | number | Royalty in basis points |
| `startTime` | number | Unix timestamp when order becomes valid |
| `endTime` | number | Unix timestamp when order expires |
| `status` | string | `active`, `filled`, `cancelled`, `expired`, `stale` |
| `createdAt` | string | ISO 8601 timestamp |
| `filledTxHash` | string \| null | Transaction hash if filled |
| `filledAt` | string \| null | ISO 8601 timestamp if filled |
| `cancelledTxHash` | string \| null | Transaction hash if cancelled |
| `cancelledAt` | string \| null | ISO 8601 timestamp if cancelled |
| `orderJson` | object | Full Seaport OrderComponents (needed to fill on-chain) |
| `signature` | string | EIP-712 signature |
