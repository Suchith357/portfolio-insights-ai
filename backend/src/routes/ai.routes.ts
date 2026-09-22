/**
 * AI routes (PortfolioIQ AI foundation) — mounted at /api/ai.
 *
 *   GET  /api/ai/status            — availability + config summary (any user)
 *   POST /api/ai/query             — grounded financial question (any user)
 *   POST /api/admin/ai/index/rebuild — rebuild FAISS index (ADMIN only)
 *
 * No secrets, model paths or internal endpoints are exposed. The AI layer is
 * additive: if it is down, every other route is unaffected.
 */

import { Router } from "express";
import { z } from "zod";
import { requireAuth, requireAdmin, currentUser } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { rateLimit } from "../middleware/rate-limit.js";
import { ok, notFound } from "../utils/http.js";
import { prisma } from "../utils/prisma.js";
import * as aiService from "../ai/service.js";
import { rebuildIndex } from "../ai/indexer.js";
import { analyzeEvent } from "../services/news/ai-event-analysis.service.js";
import { startAnalysisJob, getJob, getLatestJob } from "../services/ai/analysis-job.service.js";
import { resolveStock } from "../ai/research/stock-research.service.js";
import { recordAudit } from "../utils/audit.js";

const querySchema = z.object({
  question: z.string().trim().min(3).max(1000),
  kind: z
    .enum(["general_qa", "stock_analysis", "buy_analysis", "portfolio_news_analysis", "alert_analysis", "performance_analysis", "scenario_analysis"])
    .optional(),
  stockSymbol: z.string().trim().min(1).max(20).regex(/^[A-Za-z0-9&\-.]+$/).optional(),
  eventId: z.coerce.number().int().positive().optional(),
  topK: z.coerce.number().int().min(1).max(25).optional(),
});

const aiLimiter = rateLimit({ windowMs: 60 * 1000, max: 10, scope: "ai", message: "AI queries are rate-limited. Please wait a moment." });

export const aiRouter = Router();

aiRouter.use(requireAuth);

aiRouter.get("/status", async (_req, res, next) => {
  try {
    const status = await aiService.getStatus();
    ok(res, status);
  } catch (err) {
    next(err);
  }
});

aiRouter.post("/query", aiLimiter, validate(querySchema, "body"), async (req, res, next) => {
  try {
    const user = currentUser(req);
    const body = req.body as z.infer<typeof querySchema>;
    const result = await aiService.query({
      question: body.question,
      kind: body.kind,
      stockSymbol: body.stockSymbol,
      eventId: body.eventId,
      topK: body.topK,
    });
    ok(res, result);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------
// Feature B: event-aware AI endpoints. RAG retrieval + grounded analysis
// scoped to the platform's stocks/events; portfolio endpoints enforce
// ownership so a user only ever sees their own exposure data.
// ---------------------------------------------------------------------

const symbolParams = z.object({ symbol: z.string().trim().min(1).max(20).regex(/^[A-Za-z0-9&\-.]+$/) });

/** GET /api/ai/news/:symbol — recent news articles for one stock (RAG evidence view). */
aiRouter.get("/news/:symbol", validate(symbolParams, "params"), async (req, res, next) => {
  try {
    const { symbol } = req.params as unknown as z.infer<typeof symbolParams>;
    const stock = await prisma.stocks.findFirst({ where: { symbol: symbol.toUpperCase() }, select: { stock_id: true, symbol: true, company_name: true } });
    if (!stock) throw notFound("Unknown symbol.");
    const articles = await prisma.intelligence_news_articles.findMany({
      orderBy: { published_at: "desc" },
      take: 25,
      where: { entities: { some: { stock_id: stock.stock_id } } },
      select: { article_id: true, provider: true, title: true, description: true, url: true, source_name: true, published_at: true },
    });
    ok(res, { symbol: stock.symbol, company: stock.company_name, articles });
  } catch (err) {
    next(err);
  }
});

/** GET /api/ai/events/:symbol — recent intelligence events touching one stock. */
aiRouter.get("/events/:symbol", validate(symbolParams, "params"), async (req, res, next) => {
  try {
    const { symbol } = req.params as unknown as z.infer<typeof symbolParams>;
    const stock = await prisma.stocks.findFirst({ where: { symbol: symbol.toUpperCase() }, select: { stock_id: true } });
    if (!stock) throw notFound("Unknown symbol.");
    const events = await prisma.intelligence_news_events.findMany({
      where: { event_entities: { some: { stock_id: stock.stock_id } } },
      orderBy: { detected_at: "desc" },
      take: 20,
      select: { event_id: true, category: true, title: true, summary: true, severity: true, confidence: true, detected_at: true, status: true, ai_analysis: true },
    });
    ok(res, {
      symbol: symbol.toUpperCase(),
      events: events.map((e) => ({
        eventId: e.event_id,
        category: e.category,
        title: e.title,
        summary: e.summary,
        severity: e.severity,
        confidence: e.confidence === null ? null : Number(e.confidence),
        detectedAt: e.detected_at,
        status: e.status,
        hasAiAnalysis: e.ai_analysis !== null,
      })),
    });
  } catch (err) {
    next(err);
  }
});

/** GET /api/ai/portfolio-alerts — my intelligence alerts with AI context (own data only). */
aiRouter.get("/portfolio-alerts", async (req, res, next) => {
  try {
    const user = currentUser(req);
    const alerts = await prisma.alerts.findMany({
      where: { user_id: user.userId, source: "INTELLIGENCE" },
      orderBy: { created_at: "desc" },
      take: 50,
      select: {
        alert_id: true, title: true, message: true, severity: true, alert_type: true,
        is_read: true, created_at: true, intelligence_event_id: true,
        stocks: { select: { symbol: true } },
      },
    });
    ok(res, {
      alerts: alerts.map((a) => ({
        id: a.alert_id,
        title: a.title,
        message: a.message,
        severity: a.severity,
        alertType: a.alert_type,
        symbol: a.stocks?.symbol ?? null,
        isRead: a.is_read,
        createdAt: a.created_at,
        eventId: a.intelligence_event_id,
      })),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/ai/event/:eventId/analyze — grounded AI assessment of one event.
 * Rate-limited; user context scopes the portfolio-exposure facts. When AI is
 * unavailable the deterministic assessment is returned with a reason.
 */
const eventIdParams = z.object({ eventId: z.coerce.number().int().positive() });
aiRouter.post("/event/:eventId/analyze", aiLimiter, validate(eventIdParams, "params"), async (req, res, next) => {
  try {
    const user = currentUser(req);
    const { eventId } = req.params as unknown as z.infer<typeof eventIdParams>;
    const outcome = await analyzeEvent(eventId, user.userId);
    if (outcome.reason === "event not found") throw notFound("Event not found.");
    ok(res, outcome);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/ai/stock/:symbol/analyze — START a deep-analysis background job
 * (Requirements 4–6). Returns immediately with { jobId, status } — the heavy
 * work (context build → RAG → decision engine → Qwen3 narrative) continues
 * on the backend independently of the user's route, tab or presence.
 * Body: { mode?: "BUY" | "PORTFOLIO", question?: string }.
 *  - BUY mode: standalone attractiveness analysis.
 *  - PORTFOLIO mode: adds the authenticated user's actual position context
 *    (ownership comes from the JWT — never a client-supplied userId).
 * The decision is deterministic (decision-engine-v1); the LLM only explains.
 */
const analyzeBody = z.object({
  mode: z.preprocess((v) => (typeof v === "string" ? v.toUpperCase() : v), z.enum(["BUY", "PORTFOLIO"]).default("BUY")),
  question: z.string().trim().max(400).optional(),
});
const analyzeParams = z.object({ symbol: z.string().trim().min(1).max(20).regex(/^[A-Za-z0-9&\-.]+$/) });

aiRouter.post("/stock/:symbol/analyze", aiLimiter, validate(analyzeParams, "params"), validate(analyzeBody, "body"), async (req, res, next) => {
  try {
    const user = currentUser(req);
    const { symbol } = req.params as unknown as z.infer<typeof analyzeParams>;
    const body = req.body as z.infer<typeof analyzeBody>;

    // Cheap pre-flight: unknown symbol → 404 immediately, before any job is
    // created (same contract as before — 404 even when AI is down).
    const stock = await prisma.stocks.findFirst({ where: { symbol: symbol.toUpperCase() }, select: { stock_id: true } });
    if (!stock) throw notFound(`Unknown symbol ${symbol}.`);

    const job = startAnalysisJob({ symbol, userId: user.userId, mode: body.mode, question: body.question });
    ok(res, { jobId: job.jobId, status: job.status, symbol: job.symbol, mode: job.mode, createdAt: job.createdAt }, 202);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/ai/stock/jobs/latest?symbol=RELIANCE&mode=BUY — resume view for
 * "the user left and came back": returns the most recent job for this symbol
 * (any terminal state persists for the TTL), so a returning user sees the
 * completed report instead of a blank panel.
 * NOTE: declared BEFORE /stock/jobs/:jobId so Express never treats "latest"
 * as a jobId.
 */
const latestJobQuery = z.object({
  symbol: z.string().trim().min(1).max(20).regex(/^[A-Za-z0-9&\-.]+$/),
  mode: z.preprocess((v) => (typeof v === "string" ? v.toUpperCase() : v), z.enum(["BUY", "PORTFOLIO"]).optional()),
});
aiRouter.get("/stock/jobs/latest", validate(latestJobQuery, "query"), async (req, res, next) => {
  try {
    const user = currentUser(req);
    const q = req.query as unknown as z.infer<typeof latestJobQuery>;
    const job = getLatestJob(q.symbol, user.userId, q.mode);
    if (!job) return ok(res, null);
    ok(res, jobPayload(job));
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/ai/stock/jobs/:jobId — poll one analysis job (Requirements 4–6).
 * Ownership enforced from the JWT: a user can only see their own jobs.
 * Declared AFTER /jobs/latest but BEFORE any /stock/:symbol capture.
 */
const jobIdParams = z.object({ jobId: z.string().uuid() });
aiRouter.get("/stock/jobs/:jobId", validate(jobIdParams, "params"), async (req, res, next) => {
  try {
    const user = currentUser(req);
    const { jobId } = req.params as unknown as z.infer<typeof jobIdParams>;
    const job = getJob(jobId, user.userId);
    if (!job) throw notFound("Analysis job not found (it may have expired, or it belongs to another session).");
    ok(res, jobPayload(job));
  } catch (err) {
    next(err);
  }
});

/** Shared job response shape: payloads only when terminal. */
function jobPayload(job: {
  jobId: string; symbol: string; mode: "BUY" | "PORTFOLIO"; status: string; stageDetail: string | null;
  createdAt: string; updatedAt: string; finishedAt: string | null; report: unknown; error: string | null;
}) {
  return {
    jobId: job.jobId,
    symbol: job.symbol,
    mode: job.mode,
    status: job.status,
    stageDetail: job.stageDetail,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    finishedAt: job.finishedAt,
    // Payloads only when terminal — polling clients can render progress
    // without receiving the full report on every tick.
    report: job.status === "COMPLETED" ? { status: "OK", report: job.report } : null,
    error: job.status === "FAILED" ? job.error : null,
  };
}

/** GET /api/ai/stock/resolve?q=... — symbol resolution for natural questions. */
const resolveQuery = z.object({ q: z.string().trim().min(2).max(60) });
aiRouter.get("/stock/resolve", validate(resolveQuery, "query"), async (req, res, next) => {
  try {
    const { q } = req.query as unknown as z.infer<typeof resolveQuery>;
    const matches = await resolveStock(q);
    if (matches === null) throw notFound("No matching stock.");
    ok(res, { matches, ambiguous: matches.length > 1 });
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------------------- ADMIN
export const adminAiRouter = Router();

adminAiRouter.use(requireAuth, requireAdmin);

adminAiRouter.post("/index/rebuild", async (_req, res, next) => {
  try {
    const user = currentUser(_req);
    const result = await rebuildIndex();
    await recordAudit({
      userId: user.userId,
      action: "AI_INDEX_REBUILD",
      entityType: "AI_INDEX",
      details: `indexed=${result.documentsIndexed} ok=${result.ok} ms=${result.durationMs}`,
    });
    ok(res, result);
  } catch (err) {
    next(err);
  }
});

adminAiRouter.get("/index/status", async (_req, res, next) => {
  try {
    const status = await aiService.getStatus();
    ok(res, status);
  } catch (err) {
    next(err);
  }
});
