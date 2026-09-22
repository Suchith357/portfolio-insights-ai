# PortfolioIQ — Testing

## Suites (all offline/deterministic, `node:test` via tsx)

| Suite | Command | Count | Covers |
|---|---|---|---|
| AI/RAG foundation | `npm run test:ai` | 28 | document builders, FAISS round-trip + corrupt-index degradation, retrieval threshold, grounding rejection, prompt contract, malformed LLM output, `AI_RUNTIME=NONE` |
| Providers & intelligence | `npx tsx --test src/services/news/features23.test.ts` | 25 | provider fallback, invalid market data, news dedup, importance scoring, alert priority caps, AI gating (low-importance never calls LLM), cooldown |
| Stock research | `npx tsx --test src/ai/research/research.test.ts` | 15 | context gaps, factor scores, decision bands (BUY/HOLD/AVOID/INSUFFICIENT_EVIDENCE), confidence, evidence merge/dedupe, malformed LLM, unavailability |

**Current status: 68/68 passing** alongside backend typecheck, backend build,
frontend typecheck, and frontend production build.

## Live API verification (performed 2026-09-15)

- Auth: login ok; expired/missing token → 401; wrong-owner → 403; admin cross-user allowed where designed
- Validation: invalid ids/bodies → 400 via Zod
- Stored procedure endpoint `POST /api/analysis/:id/refresh`:
  owner→201 (+1 `portfolio_analysis` row), unauth→401, wrong-owner→403,
  admin→201, invalid id→400, nonexistent→404
- Regression sweep: health, stocks, intelligence, analysis, alerts → 200
- AI-unavailable path: status/query/analyze return structured
  `UNAVAILABLE` with honest reason (Ollama not running), never fabricated output
- Market-data sync through the fallback registry: 38 stocks, 373 prices, 0 failures, provenance intact
- 45-minute scheduler verified unchanged

## Manual browser checks

Dashboard · Portfolios · Portfolio detail · Stock explorer · Stock detail
(incl. AI Deep Analysis tab) · Risk diagnosis · Intelligence (+ event detail,
AI assessment panel) · Alerts · Watchlist · Admin — no console errors, honest
empty/loading/AI-unavailable states, no NaN/Infinity, responsive layout.

## Data integrity

Read-only verification after every phase: table/PK/FK/index/trigger counts,
business-key uniqueness, orphan checks, and before/after row counts
(see `docs/DATABASE.md`). No destructive operation was executed at any point.
