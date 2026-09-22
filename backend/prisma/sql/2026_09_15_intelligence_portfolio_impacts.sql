-- =============================================================================
-- PortfolioIQ — Intelligence Engine PHASE 2: portfolio impact mapping
--
-- Purely ADDITIVE. Nothing existing is dropped, altered, reset or overwritten.
--   * 1 new table: intelligence_portfolio_impacts
--       EVENT → USER → PORTFOLIO → EXPOSURE → ALERT CANDIDATE
--   * deterministic idempotency via a functional unique index (COALESCE so
--     NULL portfolio/stock keys still deduplicate)
--   * indexes for the documented lookup paths
--   * DB-level updated_at trigger (reuses existing fn_set_updated_at)
--
-- Retention: raw news stays ephemeral (Phase 1). Impacts may only point at
-- events that were promoted to permanent (expires_at NULL) — material events
-- become permanent exactly when they matter to a user's portfolio.
-- =============================================================================

CREATE TABLE IF NOT EXISTS intelligence_portfolio_impacts (
  impact_id         SERIAL PRIMARY KEY,
  event_id          INTEGER      NOT NULL,
  user_id           INTEGER      NOT NULL,
  -- NULL = user-level or watchlist impact (not tied to one portfolio)
  portfolio_id      INTEGER,
  -- NULL = user-level/macro impact (not tied to one stock)
  stock_id          INTEGER,
  exposure_type     VARCHAR(20)  NOT NULL,
  -- Share of the portfolio's market value exposed to this stock (0..1).
  portfolio_weight  NUMERIC(6,4),
  -- Share of the portfolio exposed to the affected SECTOR (0..1).
  sector_weight     NUMERIC(6,4),
  -- User-level aggregate weight across all portfolios (0..1).
  user_aggregate_weight NUMERIC(6,4),
  direction         VARCHAR(10),
  impact_severity   VARCHAR(10)  NOT NULL,
  alert_candidate   VARCHAR(20)  NOT NULL DEFAULT 'NO_ALERT',
  relevance         NUMERIC(5,4),
  confidence        NUMERIC(5,4),
  explanation       TEXT,
  -- Valuation freshness: the price date used for exposure maths.
  price_as_of       DATE,
  -- Derived on: when the exposure mapping last ran for this row.
  detected_at       TIMESTAMP(6) NOT NULL DEFAULT now(),
  created_at        TIMESTAMP(6) NOT NULL DEFAULT now(),
  updated_at        TIMESTAMP(6) NOT NULL DEFAULT now(),

  CONSTRAINT intelligence_portfolio_impacts_event_fk
    FOREIGN KEY (event_id) REFERENCES intelligence_news_events (event_id)
    ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT intelligence_portfolio_impacts_user_fk
    FOREIGN KEY (user_id) REFERENCES users (user_id)
    ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT intelligence_portfolio_impacts_portfolio_fk
    FOREIGN KEY (portfolio_id) REFERENCES portfolios (portfolio_id)
    ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT intelligence_portfolio_impacts_stock_fk
    FOREIGN KEY (stock_id) REFERENCES stocks (stock_id)
    ON DELETE SET NULL ON UPDATE NO ACTION,

  CONSTRAINT intelligence_portfolio_impacts_exposure_check
    CHECK (exposure_type IN ('DIRECT_HOLDING', 'WATCHLIST', 'SECTOR_EXPOSURE',
                             'INDIRECT_EXPOSURE', 'MACRO_EXPOSURE',
                             'COMPETITOR_EXPOSURE', 'SUPPLIER_EXPOSURE',
                             'CUSTOMER_EXPOSURE', 'UNKNOWN')),
  CONSTRAINT intelligence_portfolio_impacts_direction_check
    CHECK (direction IS NULL OR direction IN ('POSITIVE', 'NEGATIVE', 'MIXED', 'UNCERTAIN', 'NEUTRAL')),
  CONSTRAINT intelligence_portfolio_impacts_severity_check
    CHECK (impact_severity IN ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL')),
  CONSTRAINT intelligence_portfolio_impacts_alert_check
    CHECK (alert_candidate IN ('CRITICAL_ALERT', 'HIGH_ALERT', 'MEDIUM_ALERT',
                               'WATCHLIST_ALERT', 'NO_ALERT')),
  CONSTRAINT intelligence_portfolio_impacts_weight_check
    CHECK ((portfolio_weight  IS NULL OR (portfolio_weight  >= 0 AND portfolio_weight  <= 1))
       AND (sector_weight     IS NULL OR (sector_weight     >= 0 AND sector_weight     <= 1))
       AND (user_aggregate_weight IS NULL OR (user_aggregate_weight >= 0 AND user_aggregate_weight <= 1)))
);

-- Deterministic idempotency: one impact per (event, user, portfolio, stock,
-- exposure_type). COALESCE keeps NULL keys (watchlist/user-level rows)
-- deduplicated — a plain unique constraint would treat NULLs as distinct.
CREATE UNIQUE INDEX IF NOT EXISTS uq_intel_impact_dedup
  ON intelligence_portfolio_impacts (
    event_id, user_id,
    COALESCE(portfolio_id, 0), COALESCE(stock_id, 0), exposure_type
  );

CREATE INDEX IF NOT EXISTS idx_intel_impacts_user_created
  ON intelligence_portfolio_impacts (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_intel_impacts_event
  ON intelligence_portfolio_impacts (event_id);
CREATE INDEX IF NOT EXISTS idx_intel_impacts_stock
  ON intelligence_portfolio_impacts (stock_id);
CREATE INDEX IF NOT EXISTS idx_intel_impacts_user_alert
  ON intelligence_portfolio_impacts (user_id, alert_candidate);

DROP TRIGGER IF EXISTS trg_intel_impacts_updated_at ON intelligence_portfolio_impacts;
CREATE TRIGGER trg_intel_impacts_updated_at
  BEFORE UPDATE ON intelligence_portfolio_impacts
  FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();
