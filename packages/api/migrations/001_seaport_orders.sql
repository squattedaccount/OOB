-- Migration 001: Seaport v1.6 Order Book
-- Stores off-chain signed Seaport orders (listings + offers)
-- This is the standalone OOB schema — separate from any marketplace database.

CREATE TABLE IF NOT EXISTS seaport_orders (
    order_hash        TEXT PRIMARY KEY,
    chain_id          INTEGER NOT NULL,
    order_type        TEXT NOT NULL,             -- 'listing' | 'offer'
    offerer           TEXT NOT NULL,
    zone              TEXT DEFAULT '0x0000000000000000000000000000000000000000',

    -- NFT details
    nft_contract      TEXT NOT NULL,
    token_id          TEXT NOT NULL,
    token_standard    TEXT NOT NULL DEFAULT 'ERC721',

    -- Price details
    price_wei         TEXT NOT NULL,
    currency          TEXT NOT NULL,

    -- Fee details
    protocol_fee_recipient TEXT NOT NULL,
    protocol_fee_bps       INTEGER NOT NULL DEFAULT 33,
    origin_fee_recipient   TEXT,
    origin_fee_bps         INTEGER NOT NULL DEFAULT 0,

    -- Royalty (optional)
    royalty_recipient  TEXT,
    royalty_bps        INTEGER DEFAULT 0,

    -- Full order data for on-chain fulfillment
    order_json        JSONB NOT NULL,
    signature         TEXT NOT NULL,

    -- Timestamps
    start_time        BIGINT NOT NULL,
    end_time          BIGINT NOT NULL,
    created_at        TIMESTAMPTZ DEFAULT NOW(),

    -- Status tracking
    status            TEXT NOT NULL DEFAULT 'active',
    filled_tx_hash    TEXT,
    filled_at         TIMESTAMPTZ,
    cancelled_tx_hash TEXT,
    cancelled_at      TIMESTAMPTZ
);

-- Indexes for common query patterns
CREATE INDEX IF NOT EXISTS idx_seaport_orders_collection
  ON seaport_orders (chain_id, nft_contract, status);

CREATE INDEX IF NOT EXISTS idx_seaport_orders_token
  ON seaport_orders (chain_id, nft_contract, token_id, status);

CREATE INDEX IF NOT EXISTS idx_seaport_orders_offerer
  ON seaport_orders (chain_id, offerer, status);

CREATE INDEX IF NOT EXISTS idx_seaport_orders_type_status
  ON seaport_orders (order_type, status);

CREATE INDEX IF NOT EXISTS idx_seaport_orders_expiry
  ON seaport_orders (end_time) WHERE status = 'active';
