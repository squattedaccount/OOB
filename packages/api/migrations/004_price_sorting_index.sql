-- Migration 004: Add index for price sorting
-- The API sorts by CAST(price_wei AS NUMERIC) which is expensive without an index.
-- This expression index covers both price_asc and price_desc sort queries.

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_seaport_orders_price_numeric
  ON seaport_orders ((CAST(price_wei AS NUMERIC)))
  WHERE status = 'active';

-- Composite index for collection + price sorting (most common query pattern)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_seaport_orders_collection_price
  ON seaport_orders (chain_id, nft_contract, (CAST(price_wei AS NUMERIC)))
  WHERE status = 'active';
