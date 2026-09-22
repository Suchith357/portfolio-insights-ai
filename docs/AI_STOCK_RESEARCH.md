# AI Deep Stock Research — Methodology & Architecture (Prompt 4)

> PortfolioIQ provides evidence-based financial analysis for research and decision support.
> It does **not** guarantee future performance and must not be treated as personalized
> financial advice. The decision framework is a transparent, deterministic scoring model —
> not a prediction.

---

## 1. What this feature does

On any stock page the user can run **"AI Deep Analysis"** (buy mode) or
**"Is it good for MY portfolio?"** (portfolio mode). The backend:

1. Resolves the symbol (deterministic DB lookup — works even when the AI runtime is down).
2. Builds an **authoritative context** from PostgreSQL + the existing quantitative engine.
3. Retrieves **RAG evidence** (FAISS + Qwen3-Embedding-0.6B) with multiple targeted queries.
4. Computes a **deterministic decision** (BUY / HOLD / AVOID / INSUFFICIENT_EVIDENCE).
5. Only then calls **Qwen3-4B-Instruct (q4_K_M via Ollama)** to *explain* the numbers.
6. Returns a structured, Zod-validated report with evidence citations `[E1]..[En]`.

The LLM never computes financial facts and never overrides the decision engine.
If Ollama, the embedding model, or the FAISS index is unavailable, the endpoint returns
a structured `UNAVAILABLE` state — every other PortfolioIQ feature keeps working.

## 2. Data pipeline (authoritative context)

`backend/src/ai/research/stock-context.service.ts` assembles, with per-item freshness:

| Section | Source |
|---|---|
| Identity | `stocks` (symbol, company, exchange, sector, industry) |
| Market | Latest price + 20-day avg volume + 52-week band (source-stamped, staleness flagged) |
| Performance | 1W/1M/3M/6M/1Y/3Y/5Y returns from date-aligned closes; unavailable periods are `null` with a reason |
| Fundamentals | `stocks` (market cap, P/E, dividend yield) + freshness timestamp |
| Risk | Existing quantitative engine (volatility, max drawdown, risk band, observation count) |
| Benchmark | Existing benchmark engine (β, α, benchmark return, tracking error, N observations) |
| News/Events | `intelligence_news_articles` / `intelligence_news_events` (+ entity relationship, direction, severity) |
| Portfolio | Real position (qty, avg price, weight, unrealized P&L, holding period) — **only** the requesting owner's; absent ⇒ "Potential investment" |

Missing data is never zero-filled; it is `null` with an explicit reason.

## 3. RAG retrieval strategy

`research-retrieval.service.ts` runs **multiple targeted queries** rather than one generic
search: company news, company events, sector events, macro/policy events, historical
analogue context, and company financial information. Results are merged, deduplicated by
`documentId`, re-ranked by relevance, and trimmed to an evidence budget. Retrieval quality
is summarized as a score in `[0,1]` plus human-readable reasons; it feeds both the
decision engine and the confidence calculation.

## 4. Decision framework (decision-engine-v1)

Six factor scores, each 0–100 (missing inputs degrade to **neutral 50**, never 0):

| Factor | Default weight | Inputs |
|---|---|---|
| financial_quality | 0.20 | P/E, market cap, dividend yield |
| momentum | 0.20 | blended 1M/3M/6M/1Y returns (weights renormalized over available periods) |
| risk | 0.15 | volatility, max drawdown (band-mapped) |
| relative_performance | 0.15 | stock return vs benchmark return, β/α-aware |
| news_outlook | 0.20 | unique events weighted by severity × confidence × directness (repeats do not multiply a signal) |
| evidence_quality | 0.10 | retrieval quality score |

Weights are configurable via `AI_DECISION_WEIGHTS` (comma-separated, must sum to 1.0 ± 0.01;
invalid values fall back to the defaults above).

**Decision bands** (all thresholds in one documented place):

- `BUY` — score ≥ 62 **and** confidence ≥ 0.45 **and** risk level ≠ VERY_HIGH
- `AVOID` — score ≤ 42
- `INSUFFICIENT_EVIDENCE` — evidence quality < 0.30 (no confident call is made)
- otherwise `HOLD`

`VERY_HIGH` risk **never** yields BUY regardless of score.

## 5. Confidence methodology

Confidence is **evidence-driven**, not "how confident the LLM sounds". It starts at 0.35 and
adjusts for: fresh price data (+0.20), fundamentals present (+0.10), risk statistics
available (+0.15), benchmark available (+0.10), retrieval quality (+0.15 × quality), minus
penalties for factor data gaps and stale prices. It is clamped to `[0.05, 0.95]` — it is
never allowed to reach 1.0. Every deduction is returned in `confidenceReasons` so the UI
can show *why* confidence is reduced.

## 6. LLM layer & grounding

- Layered prompts (`research-prompts.ts`): analyst system prompt + grounding rules +
  authoritative context + evidence + user question. The prompt explicitly forbids
  fabricating data/sources, forbids recalculating authoritative numbers, requires
  `[E#]` citations, and requires distinguishing facts from interpretation.
- Output is parsed and validated by a strict Zod schema (`report-schema.ts`); malformed
  output is repaired (code fences, trailing commas) or rejected — a bad LLM response can
  never crash the backend.
- `INSUFFICIENT_EVIDENCE` returns a **deterministic skeleton report** (facts + decision +
  limitations) without narrative generation.

## 7. Caching

Reports are cached in-memory keyed by `symbol|mode|user` with:
- version = `stock-research-v1` (bumped when methodology changes),
- fingerprint = evidence document IDs + latest article/event + price date —
  so new material news invalidates the cache, and
- TTL = `AI_RESEARCH_CACHE_MINUTES` (default 45).

## 8. API

| Endpoint | Auth | Notes |
|---|---|---|
| `POST /api/ai/stock/:symbol/analyze` | JWT | body `{ mode?: "BUY"\|"PORTFOLIO", question? }` (case-insensitive mode); 10 req/min limiter; unknown symbol → 404 **even when AI is down**; AI-down → 200 `{status:"UNAVAILABLE"}` |
| `GET /api/ai/stock/resolve?q=` | JWT | symbol resolution for natural questions; ambiguous matches are flagged, not guessed |

Portfolio context is fetched for the **authenticated user only** — no cross-user exposure.

## 9. Frontend

Stock Detail page gains an **"AI Deep Analysis"** tab (`ai-research-panel.tsx`) rendering:
recommendation card (decision/score/confidence/risk), executive summary, financial,
performance, news, sector/macro and historical sections, bull/base/bear scenarios,
what-to-watch, decision reasoning, expandable evidence with source links, limitations,
and the concise disclaimer. Existing design system is reused; nothing else was redesigned.

## 10. Tests

`backend/src/ai/research/research.test.ts` (15 tests, offline & deterministic): decision
bands, VERY_HIGH-risk BUY block, neutral-50 degradation, risk levels, event-weighting,
confidence behaviour, weight validation, schema parsing (valid / fenced / trailing-comma /
malformed), stock resolution. Full suite: **15 + 28 + 25 = 68 tests pass**.

## 11. Limitations

- Fundamentals are limited to what `stocks` stores (no statement-level financials yet).
- Alpha/beta require benchmark history; without it, relative-performance degrades to
  neutral and confidence drops.
- The LLM path requires Ollama + pulled models (~3.1 GB) and a built FAISS index; without
  them the endpoint reports `UNAVAILABLE` by design rather than faking analysis.
- Scenarios are qualitative drivers with evidence — never numeric price predictions.
- This is decision support for research; it is not investment advice and places no trades.
