-- Requirement 2: financial-year fundamentals for AI deep analysis.
-- Stores the LAST TWO fiscal years (annual income statement + cash flow) and
-- growth statistics from the existing Yahoo quoteSummary pipeline as a JSONB
-- document on the stock master. Purely ADDITIVE: new nullable column, no
-- existing data touched. The document is a CACHE refreshed by the scheduled
-- fundamentals sync; analysis code treats missing data as N/A (never 0).
--
-- Shape (written by market-data.sync / fetchFundamentals):
-- {
--   fiscalYears: [ { fy: 2026, periodEnd: "2026-03-31", revenueCr, netIncomeCr,
--                    ebitdaCr, operatingCashflowCr, freeCashflowCr } ],
--   growth: { earningsGrowthPct, revenueGrowthPct, profitMarginsPct,
--             returnOnEquityPct, totalCashCr, totalDebtCr, ebitdaCr },
--   fetchedAt: ISO string, source: "YAHOO"
-- }
ALTER TABLE public.stocks
  ADD COLUMN IF NOT EXISTS financials JSONB;

COMMENT ON COLUMN public.stocks.financials IS
  'Cached FY financials (last 2 annual income statements + growth stats) from Yahoo quoteSummary; NULL = not yet fetched or unavailable from provider.';
