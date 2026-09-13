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
  port: Number(process.env["PORT"] ?? 4000),
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
};
