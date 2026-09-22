# PortfolioIQ — Multi-Provider Intelligence & AI Event Analysis

Prompt 2+3: multi-source market/news providers (Feature A) and portfolio-aware
AI alert analysis (Feature B), built on the Prompt 1 RAG foundation.

> Research/decision-support tool. Not investment advice. No price predictions.

---

## 1. Architecture & responsibility separation

```
EXTERNAL PROVIDERS      = real-world information   (Yahoo*, Alpha Vantage, GDELT, Marketaux)
POSTGRESQL              = structured source of truth
QUANTITATIVE ENGINE     = every mathematical calculation
FAISS                   = semantic retrieval index (derived, rebuildable)
RAG                     = retrieves relevant evidence
QWEN3-4B (local)        = reasoning + explanation ONLY
ALERT ENGINE            = deterministic importance/prioritization
```
\* required — everything else is optional.

## 2. Market-data providers (Feature A)

| Provider | Key | Status | Role |
|---|---|---|---|
| Yahoo Finance | none | **required, primary** | prices, OHLCV, fundamentals, benchmark (^NSEI) |
| Alpha Vantage | `ALPHA_VANTAGE_API_KEY` | optional secondary | fallback for history + fundamentals |

Normalized types (`backend/src/services/market-providers/types.ts`):
`MarketQuote`, `HistoricalPrice`, `FundamentalData`, `MarketDataResult<T>`
(failure is **data** — `ok:false, error, rateLimited` — never an exception the
sync must guess at).

**Data-quality gate** before any storage: finite values, `high ≥ low`,
`high ≥ open,close ≥ low`, positive prices, valid non-future date, non-negative
volume. A payload failing validation counts as a provider failure — NULL beats
invented data.

### Provider fallback
```
Yahoo ─ success ─▶ store (data_source=YAHOO)
   │ failure / all bars invalid
   ▼
Alpha Vantage (only if key set) ─ success ─▶ store (data_source=ALPHA_VANTAGE)
   │ failure
   ▼
record failure in market_data_syncs; store nothing; never fabricate
```
Provenance is stamped per row via the existing `data_source` column. Good data
is never blindly overwritten: upserts only refresh rows inside the fetched
window, and `latestHomogeneousSegment` keeps mixed-source series out of the
quantitative engine.

### 45-minute refresh (unchanged cadence)
`startScheduler()` runs `runSync(SCHEDULED, LATEST)` every **45 minutes**
(intentional, documented in code as "do not change"): fetch → normalize →
validate → upsert → provenance → `market_data_syncs` statistics. No duplicate
history (unique `(stock_id, price_date)` upserts), no deletions in LATEST mode.

## 3. News providers (Feature A)

| Provider | Key | Status |
|---|---|---|
| GDELT | none | default, always configured |
| Marketaux | `NEWS_MARKETAUX_API_TOKEN` | optional |

`news-registry.ts` **aggregates every configured provider**; one provider's
failure is isolated per-provider outcome data — the others continue, the
pipeline never crashes, fake news is never created. Articles normalize to
`NormalizedArticle` (provider, ids, title, description, url, source, language,
publishedAt, entities, sentiment, metadata) before the pipeline sees them.

**Dedup layers** (evidence is never deleted for being duplicated):
1. same article → `(provider, provider_article_id)` unique constraint;
2. same event re-reported → event-lifecycle signature matching converges on
   ONE `intelligence_news_events` row with accumulating `source_names` /
   `article_count` / `material_updates`;
3. numerals changed → material development → event UPDATED, not duplicated.

## 4. Event importance & alert priority (Feature B)

`event-importance.service.ts` — deterministic, explainable, multi-signal
(NOT sentiment):

| Signal | Weight |
|---|---|
| event severity (1–5) | 0.30 |
| directness (DIRECT 1.0 / SECTOR 0.5 / indirect 0.25) | 0.20 |
| best entity-match relevance | 0.15 |
| independent source count (1/2/3+) | 0.15 |
| recency (48 h linear decay) | 0.10 |
| category materiality | 0.10 |

Thresholds: ≥0.85+direct → **CRITICAL**; ≥0.70 **HIGH**; ≥0.50 **MEDIUM**;
≥0.40 **WATCH**; else **LOW**. A random article mentioning RELIANCE stays LOW;
a 3-source regulatory action directly hitting an owned stock reaches
HIGH/CRITICAL. Components are stored so the UI can show *why*.

`alert-priority.service.ts` blends event importance with Phase 3's
exposure-aware impact priority into WATCH/LOW/MEDIUM/HIGH/CRITICAL on the
**existing `alerts` table** (no new table). Non-owned rows (watchlist/sector)
never exceed MEDIUM; CRITICAL requires intrinsic importance. Dedup
(user+event+exposure kind) and the 24 h stock cooldown are unchanged — same
event from three providers = ONE event = at most ONE alert. Advice-safe:
CRITICAL means "URGENT REVIEW", never "sell".

## 5. AI event analysis (Feature B)

```
event → importance gate (LLM never sees noise) → cached? → AI ready?
      → evidence package (authoritative facts: price, 5-day move, exposure)
      → RAG retrieval → grounding gate
           ├─ insufficient → deterministic assessment only, NO model claim
           └─ sufficient   → Qwen3-4B → Zod-validated JSON → merge & cache
```

- Stored in `intelligence_news_events.ai_analysis` (JSONB, versioned
  `event-analysis-v1`) — one analysis per event, never one per article.
- Direction/importance/exposure remain engine-authoritative; the model only
  provides grounded language, key factors and evidence citations `[E1…]`.
- AI down / index empty / weak retrieval → typed reason, pipeline unaffected,
  news ingestion continues.

### Incremental RAG indexing
After each ingest: events assessed HIGH/CRITICAL are appended to FAISS
(`vectorStore.append`, single-flight, atomic tmp+rename, failed append leaves
the previous index intact). No full re-index per article; admin full rebuild
remains `POST /api/admin/ai/index/rebuild`.

## 6. APIs

| Endpoint | Auth | Purpose |
|---|---|---|
| `GET /api/ai/status` | user | AI availability + models + index |
| `POST /api/ai/query` | user, 10/min | grounded free-form financial question |
| `GET /api/ai/news/:symbol` | user | recent matched news for a stock |
| `GET /api/ai/events/:symbol` | user | recent events touching a stock |
| `GET /api/ai/portfolio-alerts` | user | **own** intelligence alerts |
| `POST /api/ai/event/:eventId/analyze` | user, 10/min | grounded AI assessment |
| `GET /api/admin/market-data/providers` | admin | provider config diagnostics |
| `POST /api/admin/ai/index/rebuild` | admin | full FAISS rebuild |

Ownership is enforced server-side; no client-supplied userId is trusted.

## 7. Configuration

```bash
# Required provider: none (Yahoo is keyless)
ALPHA_VANTAGE_API_KEY=        # optional fallback
NEWS_MARKETAUX_API_TOKEN=     # optional aggregation
# AI (Prompt 1): AI_ENABLED, AI_RUNTIME, AI_OLLAMA_BASE_URL,
# AI_LLM_MODEL, AI_EMBEDDING_MODEL, AI_RAG_TOP_K, AI_RAG_MIN_SCORE, ...
```
Free-cost operation: every component degrades gracefully to ₹0 — no key →
Yahoo+GDELT only; no Ollama → deterministic intelligence only.

## 8. Failure handling summary

| Failure | Behaviour |
|---|---|
| Yahoo fails / invalid bars | Alpha Vantage fallback (if configured) else recorded failure |
| All providers fail | sync PARTIAL/FAILED row, no data invented |
| GDELT outage | Marketaux (if configured) continues; else UNAVAILABLE status |
| Ollama down | news ingestion unaffected; AI endpoints return honest reasons |
| Grounding refuses | deterministic assessment stored, no AI claim |
| Malformed LLM JSON | typed failure, never a crash |

## 9. Evidence traceability

Every AI statement cites `[E1]…` mapped to concrete documents (title, source,
URL, published date) returned in the API response and rendered in the UI.
URLs come only from provider payloads — never generated.
