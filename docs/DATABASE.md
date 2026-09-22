# PortfolioIQ — Database

PostgreSQL is the **structured source of truth**. Prisma is the ORM; raw SQL
migrations live in `backend/prisma/sql/` (applied with
`node scripts/run-migration.cjs <file>`).

## 1. Schema summary (19+ tables)

| Domain | Tables |
|---|---|
| Identity | `users`, `audit_logs` |
| Portfolio | `portfolios`, `holdings`, `transactions`, `portfolio_analysis`, `portfolio_risk_snapshots` |
| Market | `stocks`, `stock_prices`, `benchmarks`, `benchmark_prices`, `market_data_syncs` |
| Intelligence | `intelligence_news_articles`, `intelligence_news_entities`, `intelligence_news_events`, `intelligence_event_entities`, `intelligence_portfolio_impacts` |
| User signals | `watchlists`, `alerts` |

Every table has a primary key; 25 foreign keys enforce relationships; 9 unique
constraints protect business keys (e.g. `UNIQUE(stock_id, price_date, data_source)`,
`UNIQUE(benchmark_id, price_date)`,
`UNIQUE(portfolio_id, snapshot_date, calculation_version)`); 38 CHECK constraints
guard value domains (e.g. `price >= 0`, `high >= low`, enums). 65 indexes cover
ownership, symbol, and date-range lookup paths. `updated_at` triggers exist on
mutable tables; `fn_portfolio_summary()` and helpers support common reads.

## 2. Stored procedure

**`sp_refresh_portfolio_analysis(p_portfolio_id integer, p_as_of date DEFAULT NULL)`**
— migration `backend/prisma/sql/2026_09_15_sp_refresh_portfolio_analysis.sql`.

- **Purpose:** recompute a portfolio summary risk/return snapshot entirely
  in-database from `stock_prices × holdings` and **append** one row to
  `portfolio_analysis` (never deletes or overwrites history).
- **Methodology:** values current holdings at each close over a 365-day window;
  annualized volatility `stddev(daily returns) × √252`; max drawdown via running
  max; `risk_score = min(100, vol%×0.6 + |mdd%|×1.6)`;
  `diversification_score = 100 × (1 − HHI)` of current weights. Units match
  legacy `portfolio_analysis` rows (0–100 scores, % metrics).
- **Documented limitation:** the schema stores no historical quantities, so the
  procedure uses the *current-holdings view* for the value series.
- **Example:**
  ```sql
  CALL public.sp_refresh_portfolio_analysis(1, NULL);
  SELECT * FROM portfolio_analysis WHERE portfolio_id = 1
   ORDER BY analyzed_at DESC LIMIT 1;
  ```
- **API wrapper:** `POST /api/analysis/:id/refresh` (owner-scoped; admins may
  refresh any portfolio; audited as `ANALYSIS_SNAPSHOT`).

## 3. Integrity guarantees

- Additive-only migrations; no existing table is dropped or recreated
- Duplicate prevention relies on business-key UNIQUEs + upserts (`ON CONFLICT`)
- Prisma parameterized queries everywhere (`$executeRawUnsafe` uses bound `$n`
  parameters only)
- Optional/unknown financial values are `NULL` with a reason — never 0

## 4. Backup & restore

```bash
# Backup (online, safe):
pg_dump -U portfolioiq -Fc portfolioiq > portfolioiq_$(date +%F).dump

# Verify a restore into a SEPARATE scratch database first:
createdb -U portfolioiq portfolioiq_restore_test
pg_restore -U portfolioiq -d portfolioiq_restore_test --no-owner portfolioiq_2026-09-15.dump
# sanity-check row counts, then drop the scratch DB

# Production restore (destructive to the target database):
pg_restore -U portfolioiq -d portfolioiq --clean --if-exists portfolioiq_2026-09-15.dump
```

Notes:
- `--clean --if-exists` drops objects before recreating — only for real restores
- Never test restores against the live database
- Schedule `pg_dump` via cron/Task Scheduler; keep dumps off-host

## 5. Row-count verification (final, 2026-09-15)

`users=3 portfolios=5 holdings=45 transactions=50 stocks=38 stock_prices=25035`
— verified live after all migrations; no legitimate rows deleted or modified by
any Prompt 5 change.
