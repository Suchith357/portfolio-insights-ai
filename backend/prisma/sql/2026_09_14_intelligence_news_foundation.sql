-- =============================================================================
-- PortfolioIQ — Intelligence Engine PHASE 1: news data foundation (2026-09-14)
--
-- Purely ADDITIVE. Nothing existing is dropped, altered, reset or overwritten.
--   * 4 new intelligence_* tables (ephemeral news + basic events)
--   * indexes for the documented lookup paths (no duplicate indexes)
--   * check constraints on the documented vocabularies
--   * DB-level updated_at triggers on the two mutable tables, reusing the
--     existing fn_set_updated_at() function from the 2026-09-12 migration
--
-- Raw news is TEMPORARY by design: every article row carries expires_at
-- (default TTL from env, 72h). Cleanup deletes ONLY expired intelligence
-- rows — never any existing PortfolioIQ data.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. intelligence_news_articles — temporary normalized provider news
--    Deduplicated on (provider, provider_article_id). No full article bodies:
--    title/description snippet/canonical URL/metadata only.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS intelligence_news_articles (
  article_id           SERIAL PRIMARY KEY,
  provider             VARCHAR(30)  NOT NULL,
  provider_article_id  VARCHAR(255) NOT NULL,
  title                VARCHAR(500) NOT NULL,
  description          TEXT,
  url                  TEXT         NOT NULL,
  source_name          VARCHAR(150),
  language             VARCHAR(20),
  published_at         TIMESTAMP(6) NOT NULL,
  received_at          TIMESTAMP(6) NOT NULL DEFAULT now(),
  fetched_at           TIMESTAMP(6) NOT NULL DEFAULT now(),
  expires_at           TIMESTAMP(6) NOT NULL,
  processed_at         TIMESTAMP(6),
  processing_status    VARCHAR(20)  NOT NULL DEFAULT 'PENDING',
  raw_metadata         JSONB,
  created_at           TIMESTAMP(6) NOT NULL DEFAULT now(),
  updated_at           TIMESTAMP(6) NOT NULL DEFAULT now(),

  CONSTRAINT intelligence_news_articles_provider_article_unique
    UNIQUE (provider, provider_article_id),
  CONSTRAINT intelligence_news_articles_status_check
    CHECK (processing_status IN ('PENDING', 'PROCESSED', 'FAILED'))
);

CREATE INDEX IF NOT EXISTS idx_intel_news_published
  ON intelligence_news_articles (published_at DESC);
CREATE INDEX IF NOT EXISTS idx_intel_news_expires
  ON intelligence_news_articles (expires_at);
CREATE INDEX IF NOT EXISTS idx_intel_news_status
  ON intelligence_news_articles (processing_status);

-- -----------------------------------------------------------------------------
-- 2. intelligence_news_entities — provider/entity matches against our stocks
--    Articles are ephemeral: entity rows follow their article's lifetime
--    (ON DELETE CASCADE). stock FK is optional (unmatched entity) and uses
--    SET NULL so a stock removal never blocks cleanup.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS intelligence_news_entities (
  entity_id        SERIAL PRIMARY KEY,
  article_id       INTEGER      NOT NULL,
  stock_id         INTEGER,
  matched_symbol   VARCHAR(20),
  entity_name      VARCHAR(200) NOT NULL,
  entity_type      VARCHAR(30)  NOT NULL DEFAULT 'COMPANY',
  relevance_score  NUMERIC(6,4),
  sentiment_score  NUMERIC(6,4),
  sentiment_label  VARCHAR(20),
  provider_metadata JSONB,
  created_at       TIMESTAMP(6) NOT NULL DEFAULT now(),

  CONSTRAINT intelligence_news_entities_article_fk
    FOREIGN KEY (article_id) REFERENCES intelligence_news_articles (article_id)
    ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT intelligence_news_entities_stock_fk
    FOREIGN KEY (stock_id) REFERENCES stocks (stock_id)
    ON DELETE SET NULL ON UPDATE NO ACTION,
  CONSTRAINT intelligence_news_entities_type_check
    CHECK (entity_type IN ('COMPANY', 'SECTOR', 'MACRO', 'PERSON', 'OTHER'))
);

CREATE INDEX IF NOT EXISTS idx_intel_news_entities_article
  ON intelligence_news_entities (article_id);
CREATE INDEX IF NOT EXISTS idx_intel_news_entities_stock
  ON intelligence_news_entities (stock_id);

-- -----------------------------------------------------------------------------
-- 3. intelligence_news_events — basic structured event record (Phase 1)
--    Derived from matched articles by rule-based categorisation only.
--    References to source articles are stored as ids (JSONB) rather than a
--    hard FK so events can outlive ephemeral articles without cascading.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS intelligence_news_events (
  event_id     SERIAL PRIMARY KEY,
  category     VARCHAR(30)  NOT NULL,
  title        VARCHAR(500) NOT NULL,
  summary      TEXT,
  detected_at  TIMESTAMP(6) NOT NULL DEFAULT now(),
  event_time   TIMESTAMP(6),
  severity     SMALLINT,
  relevance    NUMERIC(6,4),
  confidence   NUMERIC(5,4),
  status       VARCHAR(20)  NOT NULL DEFAULT 'NEW',
  source_article_ids JSONB,
  expires_at   TIMESTAMP(6),
  created_at   TIMESTAMP(6) NOT NULL DEFAULT now(),
  updated_at   TIMESTAMP(6) NOT NULL DEFAULT now(),

  CONSTRAINT intelligence_news_events_category_check
    CHECK (category IN ('COMPANY', 'GOVERNMENT', 'POLICY', 'TAX', 'SUBSIDY',
                        'REGULATION', 'MACRO', 'COMMODITY', 'GEOPOLITICAL',
                        'SECTOR', 'EARNINGS', 'CORPORATE_ACTION', 'OTHER')),
  CONSTRAINT intelligence_news_events_status_check
    CHECK (status IN ('NEW', 'PROCESSED', 'ARCHIVED', 'DISMISSED')),
  CONSTRAINT intelligence_news_events_severity_check
    CHECK (severity IS NULL OR (severity BETWEEN 1 AND 5))
);

CREATE INDEX IF NOT EXISTS idx_intel_events_detected
  ON intelligence_news_events (detected_at DESC);
CREATE INDEX IF NOT EXISTS idx_intel_events_category
  ON intelligence_news_events (category);
CREATE INDEX IF NOT EXISTS idx_intel_events_severity
  ON intelligence_news_events (severity);
CREATE INDEX IF NOT EXISTS idx_intel_events_expires
  ON intelligence_news_events (expires_at);

-- -----------------------------------------------------------------------------
-- 4. intelligence_event_entities — event ↔ affected entity/stock mapping
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS intelligence_event_entities (
  event_entity_id   SERIAL PRIMARY KEY,
  event_id          INTEGER     NOT NULL,
  stock_id          INTEGER,
  entity_name       VARCHAR(200) NOT NULL,
  relationship_type VARCHAR(20) NOT NULL DEFAULT 'DIRECT',
  relevance         NUMERIC(6,4),
  direction         VARCHAR(10),
  confidence        NUMERIC(5,4),
  created_at        TIMESTAMP(6) NOT NULL DEFAULT now(),

  CONSTRAINT intelligence_event_entities_event_fk
    FOREIGN KEY (event_id) REFERENCES intelligence_news_events (event_id)
    ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT intelligence_event_entities_stock_fk
    FOREIGN KEY (stock_id) REFERENCES stocks (stock_id)
    ON DELETE SET NULL ON UPDATE NO ACTION,
  CONSTRAINT intelligence_event_entities_reltype_check
    CHECK (relationship_type IN ('DIRECT', 'INDIRECT', 'SECTOR', 'MACRO',
                                 'COMPETITOR', 'SUPPLIER', 'CUSTOMER', 'OTHER')),
  CONSTRAINT intelligence_event_entities_direction_check
    CHECK (direction IS NULL OR direction IN ('POSITIVE', 'NEGATIVE', 'NEUTRAL'))
);

CREATE INDEX IF NOT EXISTS idx_intel_event_entities_event
  ON intelligence_event_entities (event_id);
CREATE INDEX IF NOT EXISTS idx_intel_event_entities_stock
  ON intelligence_event_entities (stock_id);

-- -----------------------------------------------------------------------------
-- 5. DB-level updated_at guarantees (reuse the existing trigger function)
-- -----------------------------------------------------------------------------
DROP TRIGGER IF EXISTS trg_intel_news_articles_updated_at ON intelligence_news_articles;
CREATE TRIGGER trg_intel_news_articles_updated_at
  BEFORE UPDATE ON intelligence_news_articles
  FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

DROP TRIGGER IF EXISTS trg_intel_news_events_updated_at ON intelligence_news_events;
CREATE TRIGGER trg_intel_news_events_updated_at
  BEFORE UPDATE ON intelligence_news_events
  FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();
