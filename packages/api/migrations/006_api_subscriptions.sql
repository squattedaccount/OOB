CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS api_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  primary_wallet_address TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (status IN ('active', 'suspended'))
);

CREATE TABLE IF NOT EXISTS api_account_wallets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES api_accounts(id) ON DELETE CASCADE,
  wallet_address TEXT NOT NULL UNIQUE,
  is_primary BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_api_account_wallets_account_id
  ON api_account_wallets (account_id);

CREATE TABLE IF NOT EXISTS api_projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES api_accounts(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (status IN ('active', 'disabled'))
);

CREATE INDEX IF NOT EXISTS idx_api_projects_account_id
  ON api_projects (account_id);

CREATE TABLE IF NOT EXISTS api_plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  price_usdc_cents INTEGER NOT NULL,
  billing_period_days INTEGER NOT NULL,
  active BOOLEAN NOT NULL DEFAULT true,
  entitlements_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO api_plans (code, name, price_usdc_cents, billing_period_days, entitlements_json)
VALUES
  ('starter', 'Starter', 4900, 30, '{"readRpm":120,"writeRpm":10,"maxBatchSize":5,"maxApiKeys":1,"websocketEnabled":false,"monthlyRequests":25000}'::jsonb),
  ('pro', 'Pro', 19900, 30, '{"readRpm":600,"writeRpm":60,"maxBatchSize":20,"maxApiKeys":5,"websocketEnabled":true,"monthlyRequests":250000}'::jsonb)
ON CONFLICT (code) DO NOTHING;

CREATE TABLE IF NOT EXISTS api_project_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES api_projects(id) ON DELETE CASCADE,
  plan_id UUID NOT NULL REFERENCES api_plans(id),
  status TEXT NOT NULL,
  current_period_start TIMESTAMPTZ NOT NULL,
  current_period_end TIMESTAMPTZ NOT NULL,
  cancel_at_period_end BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (status IN ('active', 'expired', 'cancelled'))
);

CREATE INDEX IF NOT EXISTS idx_api_project_subscriptions_project_id
  ON api_project_subscriptions (project_id, current_period_end DESC);

CREATE TABLE IF NOT EXISTS api_payment_quotes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES api_accounts(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES api_projects(id) ON DELETE CASCADE,
  plan_id UUID NOT NULL REFERENCES api_plans(id),
  chain_id INTEGER NOT NULL,
  token_address TEXT NOT NULL,
  token_symbol TEXT NOT NULL,
  amount_atomic TEXT NOT NULL,
  recipient_address TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (status IN ('open', 'paid', 'expired', 'cancelled'))
);

CREATE INDEX IF NOT EXISTS idx_api_payment_quotes_account_id
  ON api_payment_quotes (account_id, created_at DESC);

CREATE TABLE IF NOT EXISTS api_payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES api_accounts(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES api_projects(id) ON DELETE CASCADE,
  subscription_id UUID REFERENCES api_project_subscriptions(id) ON DELETE SET NULL,
  quote_id UUID UNIQUE REFERENCES api_payment_quotes(id) ON DELETE SET NULL,
  chain_id INTEGER NOT NULL,
  token_address TEXT NOT NULL,
  amount_atomic TEXT NOT NULL,
  tx_hash TEXT NOT NULL UNIQUE,
  from_address TEXT NOT NULL,
  to_address TEXT NOT NULL,
  confirmed_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'pending',
  raw_json JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (status IN ('pending', 'confirmed', 'rejected'))
);

CREATE TABLE IF NOT EXISTS api_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES api_projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  key_prefix TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active',
  last_used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at TIMESTAMPTZ,
  CHECK (status IN ('active', 'revoked'))
);

CREATE INDEX IF NOT EXISTS idx_api_keys_project_id
  ON api_keys (project_id, created_at DESC);

CREATE TABLE IF NOT EXISTS api_usage_counters (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES api_projects(id) ON DELETE CASCADE,
  api_key_id UUID REFERENCES api_keys(id) ON DELETE SET NULL,
  api_key_scope TEXT NOT NULL,
  period_start TIMESTAMPTZ NOT NULL,
  period_granularity TEXT NOT NULL,
  reads BIGINT NOT NULL DEFAULT 0,
  writes BIGINT NOT NULL DEFAULT 0,
  websocket_connects BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (period_granularity IN ('day', 'month'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_api_usage_unique
  ON api_usage_counters (project_id, api_key_scope, period_start, period_granularity);

CREATE TABLE IF NOT EXISTS api_auth_nonces (
  wallet_address TEXT PRIMARY KEY,
  nonce TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
