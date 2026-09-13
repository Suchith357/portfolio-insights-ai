-- =============================================================================
-- PortfolioIQ — incremental, NON-DESTRUCTIVE database upgrade (2026-09-12)
--
-- What this adds (nothing existing is dropped, reset, or overwritten):
--   1. stocks:    yahoo_symbol / data_source / fundamentals_updated_at
--   2. stock_prices: data_source ('DEMO' | 'YAHOO') so synthetic history is
--      clearly labelled and real rows can coexist without mixing
--   3. users:     password_changed_at — used to invalidate JWTs issued before
--                 a password change (session invalidation)
--   4. market_data_syncs: audit table for every market-data refresh run
--   5. DB rubric objects (documented, meaningful, non-duplicating app logic):
--        fn_set_updated_at() + BEFORE UPDATE triggers  → updated_at is always
--          bumped by the database itself, not only by ORM clients
--        fn_latest_close(stock_id)                     → indexed latest close
--        v_portfolio_summary                           → reporting VIEW used
--          for dashboards/reporting without N+1 latest-price lookups
--        fn_portfolio_summary(portfolio_id)            → parameterised
--          function over the view
--   6. Drops idx_stock_prices_stock_date — verified redundant: it indexes the
--      exact same (stock_id, price_date) columns as the pre-existing UNIQUE
--      index stock_prices_stock_date_unique, which already serves every
--      lookup the non-unique copy could.
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Stock master data: provenance + freshness
-- ---------------------------------------------------------------------------
ALTER TABLE stocks ADD COLUMN IF NOT EXISTS yahoo_symbol VARCHAR(30);
ALTER TABLE stocks ADD COLUMN IF NOT EXISTS data_source VARCHAR(20) NOT NULL DEFAULT 'DEMO';
ALTER TABLE stocks ADD COLUMN IF NOT EXISTS fundamentals_updated_at TIMESTAMP(6);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'stocks_data_source_check') THEN
    ALTER TABLE stocks ADD CONSTRAINT stocks_data_source_check
      CHECK (data_source IN ('DEMO', 'YAHOO'));
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2. Price rows carry their provenance so DEMO and real history never mix
-- ---------------------------------------------------------------------------
ALTER TABLE stock_prices ADD COLUMN IF NOT EXISTS data_source VARCHAR(20) NOT NULL DEFAULT 'DEMO';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'stock_prices_data_source_check') THEN
    ALTER TABLE stock_prices ADD CONSTRAINT stock_prices_data_source_check
      CHECK (data_source IN ('DEMO', 'YAHOO'));
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 3. Session invalidation support
-- ---------------------------------------------------------------------------
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_changed_at TIMESTAMP(6);

-- ---------------------------------------------------------------------------
-- 4. Market-data sync audit table
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS market_data_syncs (
  sync_id              SERIAL PRIMARY KEY,
  started_at           TIMESTAMP(6) NOT NULL DEFAULT now(),
  finished_at          TIMESTAMP(6),
  trigger_type         VARCHAR(20)  NOT NULL DEFAULT 'SCHEDULED',
  mode                 VARCHAR(10)  NOT NULL DEFAULT 'LATEST',
  status               VARCHAR(20)  NOT NULL DEFAULT 'RUNNING',
  stocks_processed     INTEGER      NOT NULL DEFAULT 0,
  prices_upserted      INTEGER      NOT NULL DEFAULT 0,
  fundamentals_updated INTEGER      NOT NULL DEFAULT 0,
  failures             INTEGER      NOT NULL DEFAULT 0,
  error_message        TEXT,
  CONSTRAINT market_data_syncs_trigger_check
    CHECK (trigger_type IN ('SCHEDULED', 'MANUAL', 'STARTUP')),
  CONSTRAINT market_data_syncs_mode_check
    CHECK (mode IN ('LATEST', 'FULL')),
  CONSTRAINT market_data_syncs_status_check
    CHECK (status IN ('RUNNING', 'SUCCESS', 'PARTIAL', 'FAILED'))
);

CREATE INDEX IF NOT EXISTS idx_market_data_syncs_finished
  ON market_data_syncs (finished_at DESC);

-- ---------------------------------------------------------------------------
-- 5a. updated_at trigger — DB-level guarantee (ORM-independent)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_users_updated_at ON users;
CREATE TRIGGER trg_users_updated_at
  BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

DROP TRIGGER IF EXISTS trg_portfolios_updated_at ON portfolios;
CREATE TRIGGER trg_portfolios_updated_at
  BEFORE UPDATE ON portfolios FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

DROP TRIGGER IF EXISTS trg_holdings_updated_at ON holdings;
CREATE TRIGGER trg_holdings_updated_at
  BEFORE UPDATE ON holdings FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

DROP TRIGGER IF EXISTS trg_stocks_updated_at ON stocks;
CREATE TRIGGER trg_stocks_updated_at
  BEFORE UPDATE ON stocks FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

-- ---------------------------------------------------------------------------
-- 5b. Latest-close helper — uses the (stock_id, price_date) unique index
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_latest_close(p_stock_id INTEGER)
RETURNS NUMERIC AS $$
  SELECT sp.close_price
  FROM stock_prices sp
  WHERE sp.stock_id = p_stock_id
  ORDER BY sp.price_date DESC
  LIMIT 1;
$$ LANGUAGE sql STABLE;

-- ---------------------------------------------------------------------------
-- 5c. Portfolio summary VIEW — one joined row per portfolio for dashboards
--     and reporting; removes repeated per-holding latest-price lookups.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_portfolio_summary AS
SELECT
  p.portfolio_id,
  p.user_id,
  p.name                                             AS portfolio_name,
  COUNT(h.holding_id)                                AS holding_count,
  SUM(h.quantity * h.average_buy_price)              AS invested_amount,
  SUM(h.quantity * COALESCE(fn_latest_close(h.stock_id), 0)) AS current_value,
  SUM(h.quantity * COALESCE(fn_latest_close(h.stock_id), 0))
    - SUM(h.quantity * h.average_buy_price)          AS unrealised_pnl,
  CASE
    WHEN SUM(h.quantity * h.average_buy_price) > 0 THEN
      (SUM(h.quantity * COALESCE(fn_latest_close(h.stock_id), 0))
        - SUM(h.quantity * h.average_buy_price))
      / SUM(h.quantity * h.average_buy_price) * 100
    ELSE 0
  END                                                AS unrealised_pnl_pct,
  COUNT(DISTINCT s.sector)                           AS sector_count,
  MAX(h.updated_at)                                  AS last_holding_change
FROM portfolios p
LEFT JOIN holdings h ON h.portfolio_id = p.portfolio_id
LEFT JOIN stocks   s ON s.stock_id = h.stock_id
GROUP BY p.portfolio_id, p.user_id, p.name;

-- ---------------------------------------------------------------------------
-- 5d. Parameterised function over the view
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_portfolio_summary(p_portfolio_id INTEGER)
RETURNS SETOF v_portfolio_summary AS $$
  SELECT * FROM v_portfolio_summary WHERE portfolio_id = p_portfolio_id;
$$ LANGUAGE sql STABLE;

-- ---------------------------------------------------------------------------
-- 6. Drop the verified-redundant duplicate index (same columns as the
--    UNIQUE index that already exists)
-- ---------------------------------------------------------------------------
DROP INDEX IF EXISTS idx_stock_prices_stock_date;

COMMIT;
