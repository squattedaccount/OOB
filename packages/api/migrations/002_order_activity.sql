-- Migration 002: Order Activity History
-- Tracks every lifecycle event for audit trail and UI display.

CREATE TABLE IF NOT EXISTS order_activity (
    id              SERIAL PRIMARY KEY,
    order_hash      TEXT NOT NULL REFERENCES seaport_orders(order_hash),
    chain_id        INTEGER NOT NULL,
    event_type      TEXT NOT NULL,  -- 'listed' | 'filled' | 'cancelled' | 'expired' | 'stale' | 'offer_placed'
    from_address    TEXT,           -- actor (offerer for list/cancel, buyer for fill)
    to_address      TEXT,           -- recipient (buyer for fill, seller for offer accept)
    nft_contract    TEXT,
    token_id        TEXT,
    price_wei       TEXT,
    currency        TEXT,
    tx_hash         TEXT,           -- on-chain tx hash (null for off-chain events like listing)
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_activity_order_hash ON order_activity (order_hash);
CREATE INDEX IF NOT EXISTS idx_activity_chain_collection ON order_activity (chain_id, nft_contract);
CREATE INDEX IF NOT EXISTS idx_activity_chain_token ON order_activity (chain_id, nft_contract, token_id);
CREATE INDEX IF NOT EXISTS idx_activity_from ON order_activity (from_address);
CREATE INDEX IF NOT EXISTS idx_activity_type ON order_activity (event_type);
CREATE INDEX IF NOT EXISTS idx_activity_created ON order_activity (created_at DESC);
