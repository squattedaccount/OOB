-- Webhook delivery deduplication table.
-- Prevents cross-instance replay of webhook payloads.
-- Rows auto-cleaned by cron (TTL-based).

CREATE TABLE IF NOT EXISTS webhook_dedup (
  dedup_key   TEXT PRIMARY KEY,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_webhook_dedup_created_at ON webhook_dedup (created_at);
