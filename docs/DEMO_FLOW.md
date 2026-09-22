# PortfolioIQ — Demo Flow (10–15 minutes)

A guided sequence for demos/viva, ordered to tell one story:
**data → portfolio → risk → events → evidence → AI → decisions.**

## 1. Login & security (1 min)
Sign in as `user@portfolioiq.dev`. Point out JWT auth, bcrypt hashing,
rate limiting, audit trail, and that passwords are never returned by any API.

## 2. Dashboard (1 min)
Portfolio value, allocation, and market-data freshness badge (source + last sync).
Mention the 45-minute Yahoo scheduler and provider provenance.

## 3. Portfolios & holdings (2 min)
Open *Long Term Portfolio*. Show holdings, sector spread, and per-holding P&L.
Create/edit a holding to demonstrate CRUD + Zod validation (try an invalid input → 400).

## 4. Transactions (1 min)
Add a BUY. Note that performance analytics reconstruct history from real
transactions (transaction-true view vs current-holdings view).

## 5. Risk Diagnosis (2–3 min)
Volatility, VaR/CVaR, max drawdown, Sharpe/Sortino, concentration/HHI,
marginal + component risk contributions. Show benchmark comparison (Beta/Alpha
vs NIFTY) and risk-snapshot history. Every metric shows source + observation
count + calculation version.

## 6. Intelligence & alerts (2 min)
Open Intelligence. Pick an event: source articles, entity matching, event
lifecycle, portfolio exposure mapping, deterministic importance (why it is
HIGH/CRITICAL). Show the alert with dedup/cooldown — one event, one alert.

## 7. Stock detail + AI Deep Analysis (3–4 min)
Open a heavily-held stock → **AI Deep Analysis** tab. Walk through:
executive summary → financial/performance/news analysis → bull/base/bear
scenarios → what-to-watch → evidence with clickable sources `[E1]…` →
**BUY/HOLD/AVOID** with score, confidence, and risk level. Emphasize: the
deterministic decision engine scores; the LLM only explains. Run it again on a
watchlist-only stock to show "potential investment" mode without fake exposure.

## 8. Scenario / what-if (1 min)
Buy/sell/rebalance simulation on the portfolio — read-only, no orders.

## 9. Database architecture (1 min)
19+ tables, PKs/FKs/UNIQUE/CHECK constraints, indexes, triggers,
`sp_refresh_portfolio_analysis` stored procedure (CALL it live via
"Refresh analysis" if desired), audit log contents.

## 10. RAG architecture (1 min)
PostgreSQL = truth → document builders → Qwen3-Embedding-0.6B → FAISS →
retrieval with minimum-score gate → grounded prompt → Qwen3-4B (q4_K_M, local,
~4.5 GB VRAM) → Zod-validated structured output. If evidence is insufficient
the system refuses to answer rather than inventing.

## 11. Limitations (30 sec)
- AI unavailable without Ollama → honest UNAVAILABLE state (show it)
- Free provider tiers (Alpha Vantage EOD, quota-limited)
- No predictions or guaranteed returns — decision support only
- Current-holdings view for in-DB historical valuation

## Fallback if AI is down
Everything through step 8 works; step 7/10 show the honest
"Local AI unavailable" state — itself a demonstration of the grounding design.
