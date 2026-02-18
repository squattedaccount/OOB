-- Migration 005: Add stale_checked_at for round-robin stale detection
-- Tracks when each active listing was last checked for NFT ownership.
-- The cron job orders by this column (NULLS FIRST) so all listings are
-- cycled through evenly, regardless of total count.

ALTER TABLE seaport_orders
  ADD COLUMN IF NOT EXISTS stale_checked_at TIMESTAMPTZ;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_seaport_orders_stale_checked_at
  ON seaport_orders (stale_checked_at ASC NULLS FIRST)
  WHERE status = 'active' AND order_type = 'listing' AND token_standard = 'ERC721';
