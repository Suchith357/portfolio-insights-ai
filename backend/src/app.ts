import express from "express";
import helmet from "helmet";
import cors from "cors";
import morgan from "morgan";
import { env } from "./utils/env.js";
import { notFoundHandler, errorHandler } from "./middleware/error.js";
import { prisma } from "./utils/prisma.js";

import { authRouter } from "./routes/auth.routes.js";
import { usersRouter } from "./routes/users.routes.js";
import { portfoliosRouter } from "./routes/portfolios.routes.js";
import { holdingsRouter } from "./routes/holdings.routes.js";
import { transactionsRouter } from "./routes/transactions.routes.js";
import { stocksRouter } from "./routes/stocks.routes.js";
import { watchlistRouter } from "./routes/watchlist.routes.js";
import { alertsRouter } from "./routes/alerts.routes.js";
import { analysisRouter } from "./routes/analysis.routes.js";
import { intelligenceRouter } from "./routes/intelligence.routes.js";
import { adminRouter } from "./routes/admin.routes.js";
import { aiRouter, adminAiRouter } from "./routes/ai.routes.js";

export function createApp(): express.Express {
  const app = express();

  app.disable("x-powered-by");
  app.use(helmet());
  app.use(
    cors({
      origin: env.corsOrigin,
      credentials: true,
    }),
  );
  app.use(express.json({ limit: "1mb" }));
  if (env.nodeEnv !== "test") {
    app.use(morgan("dev"));
  }

  // Liveness + database connectivity probe in one place.
  app.get("/api/health", async (_req, res, next) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      res.json({
        success: true,
        message: "PortfolioIQ backend is running",
        database: "connected",
        time: new Date().toISOString(),
      });
    } catch (err) {
      // A failed DB probe surfaces through the central error handler as a 503.
      next(err);
    }
  });

  app.use("/api/auth", authRouter);
  app.use("/api/users", usersRouter);
  app.use("/api/portfolios", portfoliosRouter);
  app.use("/api/holdings", holdingsRouter);
  app.use("/api/transactions", transactionsRouter);
  app.use("/api/stocks", stocksRouter);
  app.use("/api/watchlist", watchlistRouter);
  app.use("/api/alerts", alertsRouter);
  app.use("/api/analysis", analysisRouter);
  app.use("/api/intelligence", intelligenceRouter);
  app.use("/api/admin", adminRouter);
  // AI foundation (additive): gracefully unavailable when the local runtime is
  // absent — never a dependency of the core app.
  app.use("/api/ai", aiRouter);
  app.use("/api/admin/ai", adminAiRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
