-- Migration 007: criteria-aware order storage

ALTER TABLE seaport_orders
  ADD COLUMN IF NOT EXISTS asset_scope TEXT NOT NULL DEFAULT 'token',
  ADD COLUMN IF NOT EXISTS identifier_or_criteria TEXT;

UPDATE seaport_orders
SET identifier_or_criteria = COALESCE(identifier_or_criteria, token_id)
WHERE identifier_or_criteria IS NULL;

ALTER TABLE seaport_orders
  ALTER COLUMN identifier_or_criteria SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_seaport_orders_scope
  ON seaport_orders (chain_id, nft_contract, order_type, asset_scope, status);

CREATE INDEX IF NOT EXISTS idx_seaport_orders_identifier
  ON seaport_orders (chain_id, nft_contract, identifier_or_criteria, status);
