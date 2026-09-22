-- Feature A (multi-provider) additive migration: widen provenance CHECK
-- constraints so rows can record ALPHA_VANTAGE as their data source.
-- SAFETY: constraint definitions only. NO rows are read, updated or deleted;
-- no table is created or dropped; the 45-minute scheduler semantics are
-- untouched. Yahoo remains the default/primary provenance value.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'stock_prices_data_source_check') THEN
    ALTER TABLE stock_prices DROP CONSTRAINT stock_prices_data_source_check;
  END IF;
  ALTER TABLE stock_prices ADD CONSTRAINT stock_prices_data_source_check
    CHECK (data_source IN ('DEMO', 'YAHOO', 'ALPHA_VANTAGE'));

  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'stocks_data_source_check') THEN
    ALTER TABLE stocks DROP CONSTRAINT stocks_data_source_check;
  END IF;
  ALTER TABLE stocks ADD CONSTRAINT stocks_data_source_check
    CHECK (data_source IN ('DEMO', 'YAHOO', 'ALPHA_VANTAGE'));
END $$;
