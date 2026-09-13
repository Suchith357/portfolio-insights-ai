import { createApp } from "./app.js";
import { env } from "./utils/env.js";
import { disconnectPrisma } from "./utils/prisma.js";
import { startScheduler } from "./services/market-data.sync.js";

const app = createApp();

const server = app.listen(env.port, () => {
  console.log(`[PortfolioIQ] API listening on http://localhost:${env.port} (env: ${env.nodeEnv})`);
});

// Periodic market-data refresh (45-minute cadence; first run shortly after
// startup). The stop function is invoked on shutdown.
const stopMarketDataScheduler = startScheduler();

async function shutdown(signal: string): Promise<void> {
  console.log(`[PortfolioIQ] ${signal} received — shutting down`);
  stopMarketDataScheduler();
  server.close(async () => {
    await disconnectPrisma();
    process.exit(0);
  });
  // Force-exit safety valve.
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
