-- CHECK constraints for the PortfolioIQ schema.
-- Prisma cannot express CHECK constraints, so they are applied here.
-- These already exist in the manually created `portfolioiq` database; the
-- IF NOT EXISTS guards make the script safe to re-run on a fresh database.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_role_check') THEN
    ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('USER', 'ADMIN'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'holdings_quantity_check') THEN
    ALTER TABLE holdings ADD CONSTRAINT holdings_quantity_check CHECK (quantity > 0);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'holdings_price_check') THEN
    ALTER TABLE holdings ADD CONSTRAINT holdings_price_check CHECK (average_buy_price > 0);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'transactions_type_check') THEN
    ALTER TABLE transactions ADD CONSTRAINT transactions_type_check CHECK (transaction_type IN ('BUY', 'SELL'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'transactions_quantity_check') THEN
    ALTER TABLE transactions ADD CONSTRAINT transactions_quantity_check CHECK (quantity > 0);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'transactions_price_check') THEN
    ALTER TABLE transactions ADD CONSTRAINT transactions_price_check CHECK (price > 0);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'stock_prices_range_check') THEN
    ALTER TABLE stock_prices ADD CONSTRAINT stock_prices_range_check
      CHECK (low_price <= high_price AND open_price BETWEEN low_price AND high_price
             AND close_price BETWEEN low_price AND high_price AND low_price > 0);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'stock_prices_volume_check') THEN
    ALTER TABLE stock_prices ADD CONSTRAINT stock_prices_volume_check CHECK (volume IS NULL OR volume >= 0);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'alerts_severity_check') THEN
    ALTER TABLE alerts ADD CONSTRAINT alerts_severity_check
      CHECK (severity IN ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'analysis_score_check') THEN
    ALTER TABLE portfolio_analysis ADD CONSTRAINT analysis_score_check
      CHECK (risk_score BETWEEN 0 AND 100 AND diversification_score BETWEEN 0 AND 100);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'stocks_marketcap_check') THEN
    ALTER TABLE stocks ADD CONSTRAINT stocks_marketcap_check CHECK (market_cap IS NULL OR market_cap >= 0);
  END IF;
END
$$;
