-- Prompt 5 (final hardening): SAFE, USEFUL STORED PROCEDURE.
--
-- sp_refresh_portfolio_analysis(p_portfolio_id, p_as_of)
--   Recomputes a portfolio's summary risk/return snapshot entirely inside
--   PostgreSQL from stock_prices x holdings and APPENDS one row to the
--   existing portfolio_analysis table (never deletes/overwrites history).
--
-- Methodology (documented, deterministic):
--   window        : every price_date in [as_of - 365d .. latest price <= as_of]
--   value series  : CURRENT holdings valued at each date's close (existing
--                   schema has no quantity history, so the current-holdings
--                   view is the honest, documented limitation).
--   volatility    : stddev_samp(daily simple returns) * sqrt(252) * 100
--                   (annualised, %)
--   max_drawdown  : min(value / running_max - 1) * 100                    (%)
--   return_1y     : first->last value change over the window              (%)
--   risk_score    : min(100, vol% * 0.6 + |mdd%| * 1.6)   -- legacy 0-100 band
--   diversification_score : 100 * (1 - HHI of current weights)
--   Column semantics verified against existing legacy rows: risk_score and
--   diversification_score on 0-100, volatility/max_drawdown/return_1y in %.
--
-- Usage:
--   CALL public.sp_refresh_portfolio_analysis(1, NULL);   -- as-of today
--   SELECT * FROM public.portfolio_analysis WHERE portfolio_id = 1
--    ORDER BY analyzed_at DESC LIMIT 1;
--
-- Safety: ADDITIVE ONLY. Creates one procedure. No DDL on existing tables,
--         no data modifications. Re-runnable (CREATE OR REPLACE).

CREATE OR REPLACE PROCEDURE public.sp_refresh_portfolio_analysis(
  p_portfolio_id integer,
  p_as_of        date DEFAULT NULL
)
LANGUAGE plpgsql
AS $proc$
DECLARE
  v_as_of      date;
  v_last_date  date;   -- latest price date <= v_as_of
  v_start      date;   -- earliest price date inside the 365-day window
  v_first_val  numeric;
  v_last_val   numeric;
  v_daily_vol  numeric; -- stddev of daily returns (fraction)
  v_vol        numeric; -- annualised volatility (%)
  v_mdd        numeric; -- max drawdown (fraction, <= 0)
  v_mdd_pct    numeric; -- max drawdown (%)
  v_ret1y      numeric; -- window return (%)
  v_risk       numeric; -- 0-100 legacy band
  v_div        numeric; -- 0-100 diversification
  v_hhi        numeric;
  v_holdings   integer;
BEGIN
  IF p_portfolio_id IS NULL OR p_portfolio_id <= 0 THEN
    RAISE EXCEPTION 'sp_refresh_portfolio_analysis: portfolio_id must be a positive integer';
  END IF;

  -- The portfolio must exist; otherwise this is a caller error.
  IF NOT EXISTS (SELECT 1 FROM public.portfolios WHERE portfolio_id = p_portfolio_id) THEN
    RAISE EXCEPTION 'sp_refresh_portfolio_analysis: portfolio % does not exist', p_portfolio_id;
  END IF;

  v_as_of := COALESCE(p_as_of, CURRENT_DATE);

  SELECT MAX(price_date) INTO v_last_date
  FROM public.stock_prices
  WHERE price_date <= v_as_of;

  IF v_last_date IS NULL THEN
    RAISE EXCEPTION 'sp_refresh_portfolio_analysis: no price data on or before %', v_as_of;
  END IF;

  SELECT MIN(price_date) INTO v_start
  FROM public.stock_prices
  WHERE price_date BETWEEN (v_as_of - 365) AND v_last_date;

  -- Daily portfolio value series: current holdings valued at each day's close.
  WITH val AS (
    SELECT sp.price_date,
           SUM(h.quantity * sp.close_price) AS value
    FROM public.holdings h
    JOIN public.stock_prices sp
      ON sp.stock_id = h.stock_id
     AND sp.price_date BETWEEN v_start AND v_last_date
    WHERE h.portfolio_id = p_portfolio_id
    GROUP BY sp.price_date
  ),
  runmax AS (
    SELECT price_date,
           value,
           MAX(value) OVER (ORDER BY price_date) AS run_max
    FROM val
  ),
  ret AS (
    SELECT price_date,
           value / NULLIF(LAG(value) OVER (ORDER BY price_date), 0) - 1 AS r
    FROM val
  ),
  agg AS (
    SELECT
      (SELECT value FROM val ORDER BY price_date ASC  LIMIT 1) AS first_value,
      (SELECT value FROM val ORDER BY price_date DESC LIMIT 1) AS last_value,
      (SELECT stddev_samp(r) FROM ret WHERE r IS NOT NULL)     AS daily_vol,
      (SELECT MIN(value / NULLIF(run_max, 0) - 1) FROM runmax) AS mdd
  )
  SELECT a.first_value, a.last_value, a.daily_vol, a.mdd,
         (SELECT COUNT(*) FROM public.holdings WHERE portfolio_id = p_portfolio_id)
  INTO v_first_val, v_last_val, v_daily_vol, v_mdd, v_holdings
  FROM agg a;

  IF v_last_val IS NULL OR v_last_val = 0 OR v_first_val IS NULL OR v_first_val = 0 THEN
    RAISE EXCEPTION 'sp_refresh_portfolio_analysis: portfolio % has no valuable holdings/price data', p_portfolio_id;
  END IF;

  IF v_holdings = 0 THEN
    RAISE EXCEPTION 'sp_refresh_portfolio_analysis: portfolio % has no holdings', p_portfolio_id;
  END IF;

  v_ret1y   := (v_last_val / v_first_val - 1) * 100;
  v_vol     := COALESCE(v_daily_vol, 0) * sqrt(252) * 100;
  v_mdd_pct := COALESCE(v_mdd, 0) * 100;

  -- Legacy-compatible 0-100 risk band from annualised vol % and |mdd| %.
  v_risk := LEAST(100, v_vol * 0.6 + ABS(v_mdd_pct) * 1.6);

  -- Diversification: 100 * (1 - HHI of current weights at the latest close).
  WITH wts AS (
    SELECT h.quantity * sp.close_price AS mv,
           SUM(h.quantity * sp.close_price) OVER () AS total
    FROM public.holdings h
    JOIN LATERAL (
      SELECT close_price FROM public.stock_prices sp2
      WHERE sp2.stock_id = h.stock_id AND sp2.price_date <= v_last_date
      ORDER BY sp2.price_date DESC LIMIT 1
    ) sp ON TRUE
    WHERE h.portfolio_id = p_portfolio_id
  )
  SELECT COALESCE(SUM(POWER(mv / NULLIF(total, 0), 2)), 0) INTO v_hhi FROM wts;
  v_div := 100 * (1 - COALESCE(v_hhi, 0));

  INSERT INTO public.portfolio_analysis
      (portfolio_id, risk_score, diversification_score, volatility, max_drawdown, return_1y, analyzed_at)
  VALUES
      (p_portfolio_id, v_risk, v_div, v_vol, v_mdd_pct, v_ret1y, NOW());

  RAISE NOTICE 'sp_refresh_portfolio_analysis: portfolio % snapshot appended (vol=% %%, mdd=% %%, ret1y=% %%, risk=%, div=%)',
    p_portfolio_id, round(v_vol, 2), round(v_mdd_pct, 2), round(v_ret1y, 2),
    round(v_risk, 1), round(v_div, 1);
END;
$proc$;
