# PortfolioIQ

**Evidence-based portfolio intelligence — a full-stack financial research platform.**

PortfolioIQ combines real market data, news/event intelligence, a quantitative risk
engine, benchmark comparison, transaction-true performance, a local RAG stack, and a
locally-running LLM (Qwen3-4B via Ollama) into one explainable system.

> **Disclaimer** — PortfolioIQ is an educational/research decision-support system.
> It does not provide guaranteed investment returns or personalized financial
> advice. Every AI-generated statement is grounded in retrieved evidence and
> explicitly separates facts from interpretation. BUY/HOLD/AVOID output is the
> output of a transparent, documented scoring framework — not a prediction.

---

## Features

| Area | What you get |
|---|---|
| Portfolios | Multi-portfolio CRUD, holdings, full transaction history, watchlists |
| Market data | Yahoo Finance primary, optional Alpha Vantage fallback, 45-min scheduler, per-row provenance, sanity validation |
| Risk engine | Volatility, downside deviation, Sharpe/Sortino/Calmar, max drawdown + recovery, historical VaR 95/99, CVaR, concentration/HHI, diversification ratio, marginal/component risk, rolling metrics |
| Benchmark | NIFTY 50 (`^NSEI`) sync, Beta, Jensen's Alpha, tracking error, information ratio, upside/downside capture |
| Performance | Transaction-true P&L (realized/unrealized), holding period, turnover, BUY vs SELL reconstruction |
| Intelligence | GDELT (+ optional Marketaux) news → entity matching → event detection → lifecycle → portfolio exposure mapping |
| Alerts | Deterministic multi-signal importance (WATCH→CRITICAL), one-alert-per-event, cooldown/dedup |
| AI / RAG | Qwen3-Embedding-0.6B + FAISS retrieval, grounding gate, Qwen3-4B reasoning with `[E1]`-style citations |
| Stock research | "AI Deep Analysis" report: context → multi-query RAG → deterministic BUY/HOLD/AVOID decision engine → LLM explanation, bull/base/bear scenarios |
| Scenarios | What-if buy/sell/rebalance, historical event analogues, stress presets |
| Ops | JWT + bcrypt auth, RBAC, ownership enforcement, audit log, rate limiting, stored procedure, Docker compose |

---

## Architecture

```
 Browser (React + TanStack Start, dark fintech UI)
        │  REST (JWT)
        ▼
 Express API ── auth / RBAC / Zod validation / rate limiting / audit
        │
        ├── Market Providers ── Yahoo Finance ─┐
        │                    └─ Alpha Vantage ─┤ (fallback chain, provenance)
        ├── News Providers ─── GDELT ──────────┤
        │                    └─ Marketaux ─────┤
        ▼                                      ▼
   PostgreSQL (source of truth, 19+ tables)  Normalization + validation
        │
        ├── Quantitative Risk Engine (covariance, VaR/CVaR, Beta/Alpha, Euler contributions)
        ├── Intelligence Engine (entities → events → exposure → alerts)
        ├── FAISS vector index (semantic retrieval only)
        └── RAG + Ollama/Qwen3-4B (explanation layer — never the calculator)
```

Separation of responsibilities (enforced in code):

- **External APIs** = real-world information (no fabricated data, ever)
- **PostgreSQL** = structured source of truth
- **Quantitative engine** = all math (the LLM never calculates authoritative numbers)
- **FAISS/RAG** = evidence retrieval with a minimum-relevance grounding gate
- **Qwen3-4B (local)** = reasoning/explanation over supplied evidence
- **Alert engine** = deterministic importance/prioritization

---

## Tech stack

React 19 + TypeScript + TanStack Start/Router + Tailwind (frontend) ·
Node.js + Express + Prisma + PostgreSQL 16 (backend) ·
Ollama + Qwen3-4B-Instruct-2507 **q4_K_M** + Qwen3-Embedding-0.6B + faiss-node (AI) ·
Docker Compose (deployment).

---

## Quick start (local development)

### Prerequisites
- Node.js 20+, PostgreSQL 14+ running locally
- (Optional, for AI) [Ollama](https://ollama.com) + ~3.1 GB disk for models

### 1. Database
```bash
# create a database, then from backend/:
cp .env.example .env            # set DATABASE_URL + JWT_SECRET
npx prisma generate
npx prisma migrate deploy       # or: prisma migrate dev
for f in prisma/sql/*.sql; do node scripts/run-migration.cjs "$f"; done
npm run db:seed                 # idempotent demo accounts; never deletes data
```

### 2. Backend
```bash
cd backend
npm install
npm run dev                     # http://localhost:4000  (45-min market scheduler starts)
```

### 3. Frontend
```bash
npm install   # repo root
npm run dev                    # http://localhost:8080 (proxies /api → :4000)
```

### 4. AI (optional — everything works without it)
```bash
ollama pull qwen3:4b-instruct-2507-q4_K_M     # LLM  (~2.5 GB, ~4.5 GB VRAM)
ollama pull qwen3-embedding:0.6b              # embeddings (~0.6 GB)
# then: Admin → rebuild AI index (POST /api/admin/ai/index/rebuild)
```
If Ollama is unreachable, the UI shows **"Local AI unavailable — install/start
Ollama to enable AI analysis."** and every other feature continues working.

### Demo accounts (seeded)
| Role | Email | Password (change via env) |
|---|---|---|
| USER | `user@portfolioiq.dev` | `SEED_USER_PASSWORD` (default `demo1234`) |
| ADMIN | `admin@portfolioiq.dev` | `SEED_ADMIN_PASSWORD` (default `admin1234`) |

---

## Environment variables

See **`backend/.env.example`** (backend) and **`.env.example`** (compose) —
placeholders only, never commit real secrets.

Key backend variables: `DATABASE_URL`, `JWT_SECRET`, `JWT_EXPIRES_IN`,
`BCRYPT_ROUNDS`, `CORS_ORIGIN`, `PORT`,
`ALPHA_VANTAGE_API_KEY` *(optional)*, `MARKETAUX_API_KEY` *(optional)*,
`SEED_USER_PASSWORD`/`SEED_ADMIN_PASSWORD`,
AI: `AI_RUNTIME`, `AI_OLLAMA_BASE_URL`, `AI_LLM_MODEL`, `AI_EMBEDDING_MODEL`,
`AI_LLM_QUANTIZATION`, `AI_LLM_CONTEXT_LENGTH`, `AI_DATA_DIR`, `RAG_TOP_K`,
`RAG_MIN_SCORE`, plus decision-engine weights (`AI_WEIGHT_*`) and bands.

---

## Data providers

| Provider | Kind | Key required | Status |
|---|---|---|---|
| Yahoo Finance | market data + benchmark | none | **primary** |
| Alpha Vantage | market data fallback | `ALPHA_VANTAGE_API_KEY` (free tier) | optional |
| GDELT | news/events | none | **primary** |
| Marketaux | news fallback | `MARKETAUX_API_KEY` (free tier) | optional |

Providers run through a registry with ordered fallback and per-provider failure
isolation: a provider failure is logged and recorded, never fabricated around,
and never crashes the app. Every stored price row carries `data_source`
provenance (`YAHOO`/`ALPHA_VANTAGE`/`DEMO`).

---

## Docker

```bash
cp .env.example .env    # set POSTGRES_PASSWORD + JWT_SECRET
docker compose up --build
```
- frontend → http://localhost:3000
- backend  → http://localhost:4000
- PostgreSQL → `db` service with a named volume (survives rebuilds)
- Ollama stays on the **host** (`host.docker.internal:11434`) so the RTX GPU is used directly

---

## Backup & restore (PostgreSQL)

```bash
# Backup (safe, online):
pg_dump -U portfolioiq -Fc portfolioiq > portfolioiq_$(date +%F).dump

# Test restore into a SEPARATE database (never restore over production to test):
createdb -U portfolioiq portfolioiq_restore_test
pg_restore -U portfolioiq -d portfolioiq_restore_test --no-owner portfolioiq_2026-09-15.dump

# Production restore (destructive to the target DB — think twice):
pg_restore -U portfolioiq -d portfolioiq --clean --if-exists portfolioiq_2026-09-15.dump
```
More detail: [`docs/DATABASE.md`](docs/DATABASE.md).

---

## Testing

```bash
cd backend
npm run typecheck                 # backend typecheck
npm run build                     # backend production build
npm run test:ai                   # AI/RAG foundation suite (28)
npx tsx --test src/services/news/features23.test.ts   # providers/intelligence suite (25)
npx tsx --test src/ai/research/research.test.ts       # decision-engine suite (15)
```
Frontend: `npm run build` (root) includes type checking via the build. See
[`docs/TESTING.md`](docs/TESTING.md) for the full matrix.

---

## Documentation

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — system + module deep-dive
- [`docs/DATABASE.md`](docs/DATABASE.md) — schema, constraints, stored procedure, backup/restore
- [`docs/AI_RAG_FOUNDATION.md`](docs/AI_RAG_FOUNDATION.md) — RAG stack, quantization, grounding
- [`docs/AI_STOCK_RESEARCH.md`](docs/AI_STOCK_RESEARCH.md) — decision framework & methodology
- [`docs/PROVIDERS_AND_AI_EVENTS.md`](docs/PROVIDERS_AND_AI_EVENTS.md) — provider fallback, alert priority, AI event analysis
- [`docs/TESTING.md`](docs/TESTING.md) — verification matrix
- [`docs/DEMO_FLOW.md`](docs/DEMO_FLOW.md) — 10–15 minute demo script

## Known limitations

- AI analysis requires Ollama running locally (~4.5–5.3 GB VRAM with both models); otherwise the AI module reports UNAVAILABLE honestly.
- Alpha Vantage free tier is end-of-day and rate-limited (25/day) — used strictly as fallback.
- Historical portfolio value uses the current-holdings view where quantity history doesn't exist (documented in the stored procedure).
- News sentiment/direction is deterministic and evidence-tagged; it is not a market forecast.
