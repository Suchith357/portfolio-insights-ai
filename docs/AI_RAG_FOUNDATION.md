# PortfolioIQ — AI / RAG Foundation

This document describes the **local, free, open-source AI layer** added to
PortfolioIQ. It is a *foundation*: retrieval-augmented generation over the
platform's own financial data, with hard grounding rules that stop the model
from inventing numbers.

> **What this is:** a financial research and decision-support tool.
> **What it is not:** investment advice, a price predictor, or a guaranteed
> outcome engine. Everything the AI says is constrained to stored evidence.

---

## 1. Architecture

```
PostgreSQL (source of truth — stocks, prices, news, events, risk snapshots)
        ↓  bounded SELECTs (document builders)
Financial knowledge documents (NEWS | EVENT | STOCK_INFORMATION |
                                FINANCIAL_INFORMATION | HISTORICAL_EVENT)
        ↓
Qwen3-Embedding-0.6B  (1024-dim vectors, local via Ollama)
        ↓
FAISS index  (IndexFlatIP — inner product = cosine on unit vectors)
        ↓                                   ↑
User question ──→ embed ──→ search ──→ top-K + metadata filter + min-score
        ↓
Grounding layer: enough evidence? ── NO ─→ "Insufficient retrieved evidence"
        ↓ YES
Evidence block + quantitative facts + layered prompt
        ↓
Qwen3-4B-Instruct (4-bit, local via Ollama)
        ↓
Zod-validated structured JSON → API response
```

**Two engines, two jobs.** The **quantitative engine** (existing analytics
services) computes every number: prices, volatility, Sharpe, Sortino, VaR,
CVaR, beta, alpha, drawdown, weights. The **LLM** only *interprets and
explains* those numbers. It is explicitly instructed never to calculate,
estimate or invent a figure, and any quantitative facts it receives are
labelled *"computed by the analytics engine — authoritative, do not
recompute"*.

## 2. Why RAG?

A general-purpose LLM has no knowledge of PortfolioIQ's 38-stock universe,
its stored news corpus, or the user's risk snapshots. Fine-tuning would be
expensive, stale the moment new data arrives, and cannot cite sources. RAG
keeps facts in PostgreSQL (authoritative, updatable, auditable) and gives the
model only short, relevant, *cited* passages at query time. Answers are
traceable to evidence the user can open; when evidence is missing the system
says so instead of hallucinating.

## 3. Why PostgreSQL and FAISS have different roles

| | PostgreSQL | FAISS |
|---|---|---|
| Role | **Source of truth** — all structured data | **Semantic index** — derived, rebuildable artifact |
| Content | Stocks, prices, portfolios, holdings, transactions, news, events, impacts, alerts, risk snapshots | 1024-dim vectors + document metadata sidecar |
| Lifetime | Permanent (with the news TTL policy) | Ephemeral — deleted or corrupted at any time, rebuilt from PG in minutes |
| Queried by | Exact IDs, ranges, joins | Natural-language similarity |

FAISS never replaces a database table; it stores *no* unique data. The
metadata JSON sidecar only maps FAISS row ids back to provenance
(document id, source, URL, symbol, published date).

## 4. Model choices

### Why Qwen3-4B-Instruct (LLM)
- **Open source** (Apache-2.0) — no paid API, no vendor lock-in, runs offline.
- 4B parameters is the practical sweet spot for a **6 GB VRAM** GPU: large
  enough for coherent financial prose, small enough to leave room for context.
- Strong instruction-following for the strict JSON output contract.

### Why 4-bit quantization (RTX 4050 / 6 GB)
Full-precision Qwen3-4B needs ~8 GB VRAM for weights alone, plus KV-cache —
it does **not** fit in 6 GB. The 4-bit `q4_K_M` build cuts weights to
~2.5 GB on disk / ~3.5 GB VRAM, leaving headroom for a 4096-token context
window. Measured/expected envelope on the RTX 4050 (llama.cpp/Ollama):

| Artifact | Disk | VRAM (ctx 4096) |
|---|---|---|
| qwen3:4b-instruct q4_K_M | ~2.5 GB | ~4.5 GB |
| qwen3-embedding:0.6b | ~0.6 GB | ~0.8 GB |
| **Total** | **~3.1 GB** | **~5.3 GB** |

5.3 GB < 6 GB fits, but it is *close*: close other GPU applications when
querying. If VRAM is tight, set `AI_LLM_CONTEXT_LENGTH=2048` (KV-cache shrinks
roughly linearly) or `AI_LLM_MAX_TOKENS=256`.

### Why Qwen3-Embedding-0.6B (retrieval)
- Same Qwen3 family, Apache-2.0, dedicated **embedding** model — the 4B LLM is
  *never* used to embed (the prompt explicitly forbids it and the config makes
  it impossible: two separate model names).
- 1024-dim vectors, strong retrieval quality at 0.6 B parameters (~0.8 GB
  VRAM while embedding, then released).

## 5. Local inference setup (Windows)

1. Install Ollama: <https://ollama.com/download/windows>
2. Pull the two models (one-time, ~3.1 GB download):
   ```powershell
   ollama pull qwen3:4b-instruct-2507-q4_K_M
   ollama pull qwen3-embedding:0.6b
   ```
   (If the exact LLM tag differs, check `ollama list` and set `AI_LLM_MODEL`
   in `backend/.env` accordingly.)
3. Start the server: `ollama serve` (or let the desktop app run it).
4. Build the knowledge index (admin):
   ```powershell
   # from backend/
   #   POST /api/admin/ai/index/rebuild   with an ADMIN JWT
   ```
   This embeds a bounded window of stored news/events/stocks/snapshots and
   writes `backend/data/ai/documents.faiss` + `documents.json` (gitignored).
5. Verify: `GET /api/ai/status` → `availability: "READY"`.

**No Ollama? Nothing breaks.** `GET /api/ai/status` reports
`UNAVAILABLE` with a reason, `POST /api/ai/query` returns a structured
`UNAVAILABLE` result, and every other PortfolioIQ feature works normally.
The AI layer is additive and never a single point of failure.

## 6. Environment variables

All optional; sensible defaults are baked in. See `backend/.env.example`.

| Variable | Default | Purpose |
|---|---|---|
| `AI_ENABLED` | `true` | Master switch — `false` makes the module inert |
| `AI_RUNTIME` | `OLLAMA` | `NONE` disables model calls (status → DISABLED) |
| `AI_OLLAMA_BASE_URL` | `http://127.0.0.1:11434` | Local model server |
| `AI_LLM_MODEL` | `qwen3:4b-instruct-2507-q4_K_M` | Generative model tag |
| `AI_LLM_QUANTIZATION` | `q4_K_M` | Recorded in status/logs (informational) |
| `AI_EMBEDDING_MODEL` | `qwen3-embedding:0.6b` | Embedding model tag |
| `AI_LLM_CONTEXT_LENGTH` | `4096` | Context window (lower to save VRAM) |
| `AI_LLM_TEMPERATURE` | `0.2` | Low = grounded, deterministic-ish |
| `AI_LLM_MAX_TOKENS` | `512` | Output budget |
| `AI_LLM_TIMEOUT_MS` | `90000` | Hard wall per completion |
| `AI_RAG_TOP_K` | `6` | Documents retrieved per query |
| `AI_RAG_MIN_SCORE` | `0.35` | Minimum cosine similarity to be usable |
| `AI_RAG_MAX_EVIDENCE_CHARS` | `6000` | Evidence block budget in the prompt |
| `AI_DATA_DIR` | `<backend>/data/ai` | FAISS + metadata location (relative-free) |

No model weights, keys, or user data are ever committed: `backend/data/ai/`
and `*.faiss` are gitignored.

## 7. How to run the AI module

```powershell
# backend
npm run build            # compile
npm run test:ai          # 28 deterministic tests (no Ollama needed)
npm run dev              # start API

# with Ollama running + models pulled:
#   GET  /api/ai/status            → availability + model info
#   POST /api/ai/query             → {"question": "..."} (auth; 10 req/min)
#   POST /api/admin/ai/index/rebuild → refresh knowledge index (ADMIN)
```

## 8. Grounding / hallucination protection

Enforced in code, not just prompt text:

1. **Threshold gate** — documents below `AI_RAG_MIN_SCORE` cosine similarity
   are discarded before the LLM sees anything.
2. **Insufficient-evidence refusal** — if no document clears the threshold,
   the pipeline returns `grounding: "INSUFFICIENT_EVIDENCE"` and **the LLM is
   never called**. No answer can be fabricated without evidence.
3. **Layered prompt contract** — system instructions require: use only
   supplied evidence; cite `[E#]`; facts vs interpretation; explicit
   uncertainty; never predict prices; never calculate (quote the analytics
   engine's numbers only).
4. **Structured output validation** — the response must parse as the agreed
   JSON schema (Zod). Malformed output becomes a typed failure
   (`UNAVAILABLE`), never a crash, never silently trusted.
5. **Quantitative-engine separation** — numeric facts enter the prompt
   pre-computed and labelled authoritative; the model's job is explanation.
6. **Provenance** — every evidence row carries source, URL, symbol and
   publish date; the API returns it so the frontend can link out.

## 9. Logging

The module logs: model/runtime/quantization at startup, index rebuilds
(documents + duration), retrieval counts and top scores, grounding decisions,
LLM duration, and typed errors. It **never** logs prompts containing user
identifiers, JWTs, passwords or API keys.

## 10. Known hardware limitations

- ~5.3 GB / 6 GB VRAM at ctx 4096 — close the ceiling; reduce
  `AI_LLM_CONTEXT_LENGTH` if other apps use the GPU.
- First query after server start includes model load time (tens of seconds on
  a cold start; Ollama unloads idle models after ~5 min by default).
- Generation speed on RTX 4050: roughly 15–30 tokens/s for the 4-bit 4B model.
- Index rebuild is bounded (400 news / 150 events / 38 stocks / 120 snapshots
  by default) — one laptop, minutes not hours.

## 11. License attribution

- **Qwen3-4B-Instruct** — © Alibaba Cloud, Apache-2.0.
  <https://huggingface.co/Qwen/Qwen3-4B-Instruct-2507>
- **Qwen3-Embedding-0.6B** — © Alibaba Cloud, Apache-2.0.
  <https://huggingface.co/Qwen/Qwen3-Embedding-0.6B>
- **faiss-node** — MIT (Meta's FAISS bindings for Node).
- **Ollama** — MIT.

Model weights are downloaded by the user at deploy time and are not
redistributed with this repository.

## 12. Disclaimer

PortfolioIQ's AI layer is a **research and decision-support** feature. It
explains stored, computed evidence in plain language. It does not predict
prices, does not guarantee outcomes, does not execute trades, and is **not
financial advice**. Past performance — whether shown directly or surfaced
through retrieved historical evidence — does not guarantee future results.
