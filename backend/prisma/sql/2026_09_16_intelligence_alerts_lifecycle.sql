-- =============================================================================
-- PortfolioIQ — Intelligence Engine PHASE 3 (alert delivery + lifecycle)
-- Additive migration. Existing tables keep every column/row; only new columns,
-- constraints and indexes are added. No UPDATE/DELETE of existing data.
--   1. alerts: link intelligence alerts back to their event/impact + provenance
--   2. intelligence_news_events: enrichment counters + lifecycle status widening
--   3. intelligence_news_entities / intelligence_event_entities: explicit
--      match-confidence label (VERY_HIGH..LOW) for explainable matching
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1) alerts — additive provenance + intelligence references
-- ---------------------------------------------------------------------------
ALTER TABLE alerts
  ADD COLUMN IF NOT EXISTS intelligence_event_id INTEGER NULL,
  ADD COLUMN IF NOT EXISTS intelligence_impact_id INTEGER NULL,
  ADD COLUMN IF NOT EXISTS source VARCHAR(20) NOT NULL DEFAULT 'ANALYTICS';

-- Alerts may outlive their ephemeral event: keep the alert, drop the link.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'alerts_intelligence_event_fk') THEN
    ALTER TABLE alerts ADD CONSTRAINT alerts_intelligence_event_fk
      FOREIGN KEY (intelligence_event_id) REFERENCES intelligence_news_events(event_id)
      ON DELETE SET NULL ON UPDATE NO ACTION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'alerts_intelligence_impact_fk') THEN
    ALTER TABLE alerts ADD CONSTRAINT alerts_intelligence_impact_fk
      FOREIGN KEY (intelligence_impact_id) REFERENCES intelligence_portfolio_impacts(impact_id)
      ON DELETE SET NULL ON UPDATE NO ACTION;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_alerts_intel_event ON alerts (intelligence_event_id);
CREATE INDEX IF NOT EXISTS idx_alerts_user_source ON alerts (user_id, source);
CREATE INDEX IF NOT EXISTS idx_alerts_user_unread_created ON alerts (user_id, is_read, created_at DESC);

-- ---------------------------------------------------------------------------
-- 2) intelligence_news_events — enrichment + lifecycle
-- ---------------------------------------------------------------------------
ALTER TABLE intelligence_news_events
  ADD COLUMN IF NOT EXISTS article_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS source_names JSONB NULL,
  ADD COLUMN IF NOT EXISTS material_updates INTEGER NOT NULL DEFAULT 0;

-- Lifecycle widened (additive): NEW → UPDATED (more articles/material change)
-- → PROCESSED (impacts built) → RESOLVED/EXPIRED. Legacy values stay valid.
ALTER TABLE intelligence_news_events DROP CONSTRAINT IF EXISTS intelligence_news_events_status_check;
ALTER TABLE intelligence_news_events ADD CONSTRAINT intelligence_news_events_status_check
  CHECK (status::text = ANY (ARRAY[
    'NEW'::text, 'ACTIVE'::text, 'UPDATED'::text, 'RESOLVED'::text, 'EXPIRED'::text,
    'PROCESSED'::text, 'ARCHIVED'::text, 'DISMISSED'::text
  ]));

CREATE INDEX IF NOT EXISTS idx_intel_events_status ON intelligence_news_events (status);
CREATE INDEX IF NOT EXISTS idx_intel_events_updated ON intelligence_news_events (updated_at DESC);

-- ---------------------------------------------------------------------------
-- 3) match-confidence labels (explainable matching, Phase 3 Part B)
-- ---------------------------------------------------------------------------
ALTER TABLE intelligence_news_entities
  ADD COLUMN IF NOT EXISTS match_confidence VARCHAR(12) NULL;
ALTER TABLE intelligence_event_entities
  ADD COLUMN IF NOT EXISTS match_confidence VARCHAR(12) NULL;

ALTER TABLE intelligence_news_entities DROP CONSTRAINT IF EXISTS intelligence_news_entities_match_conf_check;
ALTER TABLE intelligence_news_entities ADD CONSTRAINT intelligence_news_entities_match_conf_check
  CHECK (match_confidence IS NULL OR match_confidence::text = ANY (ARRAY[
    'VERY_HIGH'::text, 'HIGH'::text, 'MEDIUM'::text, 'LOW'::text, 'UNMATCHED'::text
  ]));

ALTER TABLE intelligence_event_entities DROP CONSTRAINT IF EXISTS intelligence_event_entities_match_conf_check;
ALTER TABLE intelligence_event_entities ADD CONSTRAINT intelligence_event_entities_match_conf_check
  CHECK (match_confidence IS NULL OR match_confidence::text = ANY (ARRAY[
    'VERY_HIGH'::text, 'HIGH'::text, 'MEDIUM'::text, 'LOW'::text, 'UNMATCHED'::text
  ]));
