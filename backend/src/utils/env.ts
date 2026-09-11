import "dotenv/config";

function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

export const env = {
  nodeEnv: process.env["NODE_ENV"] ?? "development",
  port: Number(process.env["PORT"] ?? 4000),
  databaseUrl: required("DATABASE_URL", "postgresql://localhost:5432/portfolioiq"),
  jwtSecret: required("JWT_SECRET", "dev-only-insecure-secret-change-me"),
  jwtExpiresIn: process.env["JWT_EXPIRES_IN"] ?? "7d",
  bcryptRounds: Number(process.env["BCRYPT_ROUNDS"] ?? 10),
  corsOrigin: (process.env["CORS_ORIGIN"] ?? "http://localhost:8080")
    .split(",")
    .map((o) => o.trim()),
};
