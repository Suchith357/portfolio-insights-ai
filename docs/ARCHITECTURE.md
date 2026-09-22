# PortfolioIQ — Architecture

## 1. System overview

```
┌──────────────────────────── Browser ────────────────────────────┐
│ React 19 · TanStack Start (SSR) · Tailwind dark fintech UI      │
│ pages: Dashboard, Portfolios, Holdings, Transactions, Stocks,   │
│ Risk Diagnosis, Intelligence, Alerts, Watchlist, Admin          │
└──────────────────────────────┬──────────────────────────────────┘
                               │ REST + JWT (fetch, /api proxy)
┌──────────────────────────────▼──────────────────────────────────┐
│ Express API (backend/src)                                       │
│  middleware: requireAuth (JWT) · RBAC · Zod validate · rate     │
│  limit · centralized error handler (no stack traces in prod)    │
│                                                                 │
│  routes: auth · users · portfolios · holdings · transactions ·  │
│  stocks · watchlist · alerts · analysis · risk · intelligence · │
│  ai (/api/ai, /api/admin/ai) · admin                            │
└──────┬───────────────┬───────────────┬──────────────┬──────────┘
       │               │               │              │
       ▼               ▼               ▼              ▼
┌─────────────┐ ┌─────────────┐ ┌─────────────┐ ┌──────────────┐
│ PostgreSQL  │ │ Provider    │ │ Quantitative│ │ AI module    │
│ (source of  │ │ layer       │ │ risk engine │ │ (local only) │
│  truth)     │ │ Yahoo → AV  │ │ (pure TS)   │ │ FAISS+RAG    │
│ 19+ tables  │ │ GDELT → MX  │ │ covariance, │ │ → Ollama     │
│             │ │             │ │ VaR, Euler  │ │ Qwen3-4B     │
└─────────────┘ └─────────────┘ └─────────────┘ └──────────────┘
```

## 2. Backend module map

| Module | File(s) | Responsibility |
|---|---|---|
| Market-data sync | `services/market-data.sync.ts` | 45-min scheduler, upserts, provenance, `market_data_syncs` stats |
| Market providers | `services/market-providers/*` | `MarketDataProvider` interface, registry, Yahoo + Alpha Vantage adapters, fallback orchestration, sanity validation |
| News ingestion | `services/news/news-ingest.ts`, `news-registry.ts` | Multi-provider aggregation, normalization, article dedup |
| Entity/event engine | `services/news/event-*.ts` | Entity matching hierarchy, event detection/classification, lifecycle, consolidation |
| Importance/priority | `event-importance.service.ts`, `alert-priority.service.ts` | 6-signal importance score → WATCH…CRITICAL; deterministic alert decision (dedup + cooldown) |
| AI event analysis | `ai-event-analysis.service.ts` | Importance gate → evidence package → RAG → Qwen → Zod-validated cached assessment (`ai_analysis` JSONB) |
| Quantitative risk | `quantitative-risk.service.ts`, `analytics.service.ts` | Date-aligned homogeneous returns, covariance risk, VaR/CVaR, drawdown, contributions, rolling metrics |
| Benchmark | `benchmark-*.ts` | NIFTY sync, Beta/Alpha, tracking error, capture ratios |
| Transaction performance | `transaction-performance.service.ts` | BUY/SELL reconstruction, realized/unrealized P&L, turnover, holding period |
| Stock research | `ai/research/*` | Context builder, multi-query retrieval, deterministic decision engine, report schema, orchestrator |
| AI foundation | `ai/*` | Config, document builders, embeddings, FAISS store, retriever, grounding gate, prompts, output schema, LLM client, indexer |

## 3. Request lifecycle (example: AI deep analysis)

1. `POST /api/ai/stock/:symbol/analyze` → JWT auth → Zod (symbol, mode) → rate limit (10/min)
2. Stock resolution (pure DB, AI-independent) → 404 if unknown
3. Availability gate → honest `UNAVAILABLE` if Ollama is down
4. Context builder assembles authoritative, source-stamped data
5. Six targeted RAG queries → merge → dedupe → rerank → budget
6. Deterministic decision engine scores factors → BUY/HOLD/AVOID/INSUFFICIENT_EVIDENCE
7. LLM receives scores + evidence only (never calculates) → layered prompt
8. Zod validates the report → fingerprint cache → response with `[E1..]` citations

## 4. Failure philosophy

- Provider/AI/LLM failure is **data** (`ok:false`, reason), not an exception path
- Missing financial values are `null` + reason — never 0, never invented
- Per-provider and per-stock isolation: one failure never stops the pipeline
- AI is additive: the entire application runs with the AI module disabled
