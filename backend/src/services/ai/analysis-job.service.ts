/**
 * Deep-analysis JOB system (Requirements 4–6).
 *
 * Previously Deep Analysis was a single ~50s synchronous HTTP request owned
 * by one React component: navigating away unmounted the component, the
 * request died with it, and the result was lost. Now the analysis runs as a
 * BACKGROUND JOB on the backend:
 *
 *   POST /api/ai/stock/:symbol/analyze  → starts the job → { jobId, status }
 *   GET  /api/ai/stock/jobs/:jobId      → { status, report?, error? }
 *   GET  /api/ai/stock/jobs/latest?symbol=REL → last job for a symbol
 *
 * The browser's only responsibilities are: start job → poll status → render
 * result. Tab minimization, route changes and leaving the site cannot affect
 * the run because nothing of the analysis lives in the frontend anymore.
 *
 * Storage: an in-process Map (bounded, TTL-swept). Results remain available
 * for RESEARCH_JOB_TTL_MINUTES (default 120) after completion — long enough
 * to navigate anywhere, close the tab, and come back within a session. The
 * authoritative report itself is ALSO cached by the existing fingerprint
 * cache in stock-research.service.ts, so a job re-run against unchanged
 * evidence is served from cache without re-paying the LLM cost.
 */
import { analyzeStockDeep } from "../../ai/research/stock-research.service.js";
import type { ResearchReport } from "../../ai/research/stock-research.service.js";

export type JobStatus = "STARTED" | "FETCHING_DATA" | "ANALYZING" | "GENERATING_INSIGHTS" | "COMPLETED" | "FAILED";

export interface AnalysisJob {
  jobId: string;
  symbol: string;
  mode: "BUY" | "PORTFOLIO";
  question: string | null;
  userId: number;
  status: JobStatus;
  stageDetail: string | null;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
  /** Set when status === COMPLETED. */
  report: ResearchReport | null;
  /** Set when status === FAILED (user-safe reason) or UNAVAILABLE outcome. */
  error: string | null;
}

/** Bounded in-memory store. Jobs are small; reports dominate the memory. */
const jobs = new Map<string, AnalysisJob>();

/** Sweep jobs older than the TTL so the map cannot grow unbounded. */
function sweep(): void {
  const ttlMs = jobTtlMinutes() * 60_000;
  const now = Date.now();
  for (const [id, job] of jobs) {
    const finished = job.finishedAt ? Date.parse(job.finishedAt) : null;
    const ageAnchor = finished ?? Date.parse(job.createdAt);
    if (Number.isFinite(ageAnchor) && now - ageAnchor > ttlMs) jobs.delete(id);
  }
  // Hard bound: keep the newest 200 jobs.
  if (jobs.size > 200) {
    const oldest = [...jobs.entries()]
      .sort((a, b) => a[1].createdAt.localeCompare(b[1].createdAt))
      .slice(0, jobs.size - 200);
    for (const [id] of oldest) jobs.delete(id);
  }
}

function jobTtlMinutes(): number {
  const n = Number(process.env["RESEARCH_JOB_TTL_MINUTES"]);
  return Number.isFinite(n) && n >= 1 ? Math.min(1440, n) : 120;
}

/** Sanitized view for API responses (never leaks internals). */
export function jobView(job: AnalysisJob): AnalysisJob {
  return { ...job };
}

export function getJob(jobId: string, userId: number): AnalysisJob | null {
  const job = jobs.get(jobId);
  // Ownership: a user may only poll their own jobs (ids are unguessable v4
  // uuids, but the check is cheap and makes the contract explicit).
  if (!job || job.userId !== userId) return null;
  return job;
}

/** Latest job for one symbol+mode for this user — powers "resume on return". */
export function getLatestJob(symbol: string, userId: number, mode?: "BUY" | "PORTFOLIO"): AnalysisJob | null {
  sweep();
  const upper = symbol.toUpperCase();
  let best: AnalysisJob | null = null;
  for (const job of jobs.values()) {
    if (job.userId !== userId || job.symbol !== upper) continue;
    if (mode && job.mode !== mode) continue;
    if (!best || job.createdAt > best.createdAt) best = job;
  }
  return best;
}

function setStage(job: AnalysisJob, status: JobStatus, detail: string | null): void {
  job.status = status;
  job.stageDetail = detail;
  job.updatedAt = new Date().toISOString();
}

/**
 * Start a background analysis. Returns immediately with the job handle; the
 * run continues on the backend even if the HTTP request's client vanishes.
 */
export function startAnalysisJob(input: {
  symbol: string;
  userId: number;
  mode: "BUY" | "PORTFOLIO";
  question?: string;
}): AnalysisJob {
  sweep();
  const jobId = crypto.randomUUID();
  const now = new Date().toISOString();
  const job: AnalysisJob = {
    jobId,
    symbol: input.symbol.toUpperCase(),
    mode: input.mode,
    question: input.question?.trim() || null,
    userId: input.userId,
    status: "STARTED",
    stageDetail: null,
    createdAt: now,
    updatedAt: now,
    finishedAt: null,
    report: null,
    error: null,
  };
  jobs.set(jobId, job);
  // Fire-and-forget: the HTTP response returns NOW; the work continues.
  void runJob(job);
  return jobView(job);
}

async function runJob(job: AnalysisJob): Promise<void> {
  try {
    setStage(job, "FETCHING_DATA", "resolving stock, prices, fundamentals, news and events");
    // analyzeStockDeep performs: resolve → context build → RAG retrieval →
    // decision engine → LLM. We surface coarse stages around it; the job's
    // lifecycle never depends on the caller staying connected.
    setStage(job, "ANALYZING", "retrieving evidence and computing deterministic factors");
    const outcome = await analyzeStockDeep({
      symbol: job.symbol,
      userId: job.userId,
      mode: job.mode,
      question: job.question ?? undefined,
    });
    if (outcome.status === "OK") {
      setStage(job, "GENERATING_INSIGHTS", "assembling the research report");
      job.report = outcome.report;
      setStage(job, "COMPLETED", null);
    } else {
      // UNAVAILABLE (AI down / index empty) and NOT_FOUND are terminal,
      // honest outcomes — not crashes.
      job.error = outcome.reason;
      job.status = "FAILED";
    }
  } catch (error) {
    job.error = error instanceof Error ? error.message.slice(0, 300) : "Analysis failed unexpectedly.";
    job.status = "FAILED";
  } finally {
    job.finishedAt = job.finishedAt ?? new Date().toISOString();
    job.updatedAt = new Date().toISOString();
  }
}

/** Test/diagnostic visibility. */
export function jobCount(): number {
  return jobs.size;
}

/** Test seam: inject a job directly (offline store tests). Never used by routes. */
export function __injectJobForTest(job: Partial<AnalysisJob> & Pick<AnalysisJob, "jobId" | "userId" | "symbol" | "mode" | "status">): void {
  const now = new Date().toISOString();
  jobs.set(job.jobId, {
    question: null,
    stageDetail: null,
    createdAt: now,
    updatedAt: now,
    finishedAt: null,
    report: null,
    error: null,
    ...job,
  } as AnalysisJob);
  // Keep the hard bound honest under churn too (mirrors sweep()).
  if (jobs.size > 200) {
    const oldest = [...jobs.entries()]
      .sort((a, b) => a[1].createdAt.localeCompare(b[1].createdAt))
      .slice(0, jobs.size - 200);
    for (const [id] of oldest) jobs.delete(id);
  }
}

/** Test seam: clear the store between tests. */
export function __clearJobsForTest(): void {
  jobs.clear();
}
