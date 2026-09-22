import "dotenv/config";

function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

const isProduction = process.env["NODE_ENV"] === "production";

/**
 * JWT secret resolution.
 * Development keeps a dev-only fallback so the project runs out of the box.
 * Production must fail fast: no fallback, no known-weak defaults — an insecure
 * or missing secret in production is a startup error, not a warning.
 */
function resolveJwtSecret(): string {
  const raw = process.env["JWT_SECRET"]?.trim();
  if (isProduction) {
    if (!raw || raw.length < 32) {
      throw new Error(
        "JWT_SECRET must be set to at least 32 characters in production. Refusing to start with an insecure secret.",
      );
    }
    if (/change-me|insecure|dev-only|secret/i.test(raw) && raw.length < 40) {
      throw new Error("JWT_SECRET looks like a placeholder. Set a real secret in production.");
    }
    return raw;
  }
  return raw || "dev-only-insecure-secret-change-me";
}

export const env = {
  nodeEnv: process.env["NODE_ENV"] ?? "development",
  // Empty/invalid PORT strings must fall back to 4000, not parse to 0.
  port: Number(process.env["PORT"]) > 0 ? Number(process.env["PORT"]) : 4000,
  databaseUrl: required("DATABASE_URL", "postgresql://localhost:5432/portfolioiq"),
  jwtSecret: resolveJwtSecret(),
  jwtExpiresIn: process.env["JWT_EXPIRES_IN"] ?? "7d",
  bcryptRounds: Number(process.env["BCRYPT_ROUNDS"] ?? 10),
  corsOrigin: (process.env["CORS_ORIGIN"] ?? "http://localhost:8080")
    .split(",")
    .map((o) => o.trim()),
  /**
   * Market-data refresh cadence (minutes). Sourced from env with a 45-minute
   * default — well inside the 30–60 minute requirement and gentle on the free
   * data source's rate limits.
   */
  marketDataRefreshMinutes: Math.max(
    15,
    Number(process.env["MARKET_DATA_REFRESH_MINUTES"] ?? 45),
  ),

  // ---------------------------------------------------------------------------
  // Intelligence Engine (Phase 1: news data foundation)
  // ---------------------------------------------------------------------------
  /**
   * News provider: "GDELT" (free, no key) or "MARKETAUX" (free tier, needs
   * NEWS_MARKETAUX_API_TOKEN). Unrecognised values fall back to GDELT.
   */
  newsProvider: (process.env["NEWS_PROVIDER"] ?? "GDELT").toUpperCase() === "MARKETAUX"
    ? "MARKETAUX"
    : "GDELT",
  /** Marketaux free-tier token; required only when NEWS_PROVIDER=MARKETAUX. */
  newsMarketauxApiToken: process.env["NEWS_MARKETAUX_API_TOKEN"]?.trim() || null,
  /**
   * Feature A: optional Alpha Vantage key. When absent the provider is
   * skipped entirely — Yahoo remains the sole market-data source. Never
   * committed; .env only.
   */
  alphaVantageApiKey: process.env["ALPHA_VANTAGE_API_KEY"]?.trim() || null,
  /** How often the news pipeline runs (minutes). Default 30; min 15. */
  newsFetchIntervalMinutes: Math.max(15, Number(process.env["NEWS_FETCH_INTERVAL_MINUTES"] ?? 30)),
  /** How often expired intelligence rows are purged (minutes). Default 60. */
  newsCleanupIntervalMinutes: Math.max(10, Number(process.env["NEWS_CLEANUP_INTERVAL_MINUTES"] ?? 60)),
  /**
   * Raw-news TTL in hours — the single configuration point for retention.
   * Nothing else in the codebase hard-codes this value.
   */
  newsRetentionHours: Math.max(1, Number(process.env["NEWS_RETENTION_HOURS"] ?? 72)),
  /** Max articles pulled per provider request (respects provider caps). */
  newsFetchLimit: Math.min(75, Math.max(10, Number(process.env["NEWS_FETCH_LIMIT"] ?? 50))),
  /** Per-request provider timeout (ms). */
  newsProviderTimeoutMs: Math.max(5_000, Number(process.env["NEWS_PROVIDER_TIMEOUT_MS"] ?? 15_000)),
  /**
   * Phase 3 alert cooldown (hours): minimum spacing between INTELLIGENCE
   * alerts for the same user+stock. Same-event dedup is separate and stricter.
   */
  newsAlertCooldownHours: Math.max(1, Number(process.env["NEWS_ALERT_COOLDOWN_HOURS"] ?? 24)),
  /**
   * STARTUP ingest freshness window (hours): how recent startup news must be.
   * Requirement: fetch ~last 1 hour of news on project start (clamped to a
   * sane 1..6 band so the GDELT timespan parameter stays meaningful).
   */
  newsStartupWindowHours: Math.min(6, Math.max(1, Number(process.env["NEWS_STARTUP_WINDOW_HOURS"] ?? 1))),
  /**
   * Ingest query pacing: free providers (GDELT) require >=5s between
   * requests; the default adds headroom. Applies between every query.
   */
  newsInterQueryDelayMs: Math.max(5_000, Number(process.env["NEWS_INTER_QUERY_DELAY_MS"] ?? 6_500)),
  /** One retry (with >=6s backoff) for transient provider errors like 429. */
  newsProviderRetries: Math.max(0, Math.min(2, Number(process.env["NEWS_PROVIDER_RETRIES"] ?? 1))),
  /**
   * Concurrent multi-provider aggregation (Req 1): how many providers may be
   * in flight at once (1–3, default 2) and the hard wall-clock bound for one
   * provider's full call. The default 45s must EXCEED the slowest provider's
   * own contract (GDELT: 30s fetch timeout + ≥5s gate spacing), otherwise the
   * aggregator would abort GDELT before GDELT could ever answer — resilience
   * comes from the other providers not waiting, not from starving one.
   */
  newsAggregatorConcurrency: Math.min(3, Math.max(1, Number(process.env["NEWS_AGGREGATOR_CONCURRENCY"] ?? 2))),
  newsAggregatorTimeoutMs: Math.max(5_000, Number(process.env["NEWS_AGGREGATOR_TIMEOUT_MS"] ?? 45_000)),
  /**
   * Market anomaly detection sensitivity (std-devs above the 90-day norm).
   * Higher = fewer alerts. DEFAULT per requirement ("abnormal behaviour").
   */
  anomalyStdDevThreshold: Math.max(1.5, Number(process.env["ANOMALY_STD_DEV_THRESHOLD"] ?? 2.0)),
  /** Fresh news window (hours) for the anomaly/news-cycle scan (Req 1: 45 min cadence). */
  anomalyNewsWindowHours: Math.max(1, Number(process.env["ANOMALY_NEWS_WINDOW_HOURS"] ?? 1)),
};
