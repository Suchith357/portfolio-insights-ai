-- Feature B additive migration: AI event-analysis cache.
-- intelligence_news_events gains ONE nullable JSONB column used as a cache of
-- the (versioned) AI assessment for important events, plus one partial index
-- used by the "important events" queries. No existing column is modified, no
-- row is touched, no constraint is dropped.

ALTER TABLE intelligence_news_events
  ADD COLUMN IF NOT EXISTS ai_analysis JSONB;

CREATE INDEX IF NOT EXISTS idx_intel_events_ai_analysis
  ON intelligence_news_events (event_id)
  WHERE ai_analysis IS NOT NULL;
