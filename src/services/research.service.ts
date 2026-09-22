/**
 * Deep AI stock research (Prompt 4 + Requirements 4–6) — job-based client.
 *
 * The analysis runs as a BACKGROUND JOB on the backend:
 *   POST /ai/stock/:symbol/analyze → { jobId, status } (202)
 *   GET  /ai/stock/jobs/:jobId     → { status, report?, error? }
 *   GET  /ai/stock/jobs/latest?symbol=…&mode=… → resume an existing job
 *
 * The frontend never owns the analysis lifetime anymore: navigating away,
 * minimizing the tab or closing the site cannot stop a run, and the finished
 * report stays available (job TTL) so returning users see their result.
 */
import { apiRequest } from "./api-client";

export interface ResearchFactor {
  name: string;
  score: number;
  detail: string;
  dataAvailable: boolean;
}

export interface ResearchReport {
  stock: { symbol: string; companyName: string };
  recommendation: {
    decision: "BUY" | "HOLD" | "AVOID" | "INSUFFICIENT_EVIDENCE";
    score: number;
    confidence: number;
    riskLevel: string;
    version: string;
  };
  executive_summary: string;
  current_situation: string;
  /** Deterministic beginner-friendly explanations (Req 8). */
  metric_explanations: Array<{
    metric: string;
    value: string;
    meaning: string;
    higherMeans: string;
    lowerMeans: string;
    interpretation: string;
  }>;
  financial_analysis: { summary: string; positive_factors: string[]; negative_factors: string[]; valuation: string; financial_quality: number };
  performance_analysis: { summary: string; relative_to_benchmark: string; periods: Array<{ period: string; pct: number | null; reason?: string }> };
  risk_analysis: { summary: string; volatility: number | null; drawdown: number | null; beta: number | null; var: number | null; cvar: number | null };
  news_analysis: { summary: string; overall_direction: string; important_events: string[]; positive_factors: string[]; negative_factors: string[] };
  sector_macro_analysis: { summary: string; factors: string[] };
  historical_context: { summary: string; available: boolean; sample_size: number };
  scenarios: Record<"bull" | "base" | "bear", { narrative: string; drivers: string[]; invalidators: string[] }>;
  what_to_watch: string[];
  decision_reasoning: string[];
  evidence: Array<{ id: string; title: string; source: string; url: string | null; published_at: string | null; relevance: number }>;
  limitations: string[];
  meta: {
    version: string;
    mode: "BUY" | "PORTFOLIO";
    cached: boolean;
    generatedAt: string;
    evidenceQuality: number;
    llmMs: number | null;
    factors: ResearchFactor[];
    weights: Record<string, number>;
    confidenceReasons: string[];
    dataQualityNotes: string[];
  };
}

export type ResearchOutcome =
  | { status: "OK"; report: ResearchReport }
  | { status: "UNAVAILABLE"; reason: string };

/** Lifecycle states surfaced by the backend job system. */
export type JobStatus = "STARTED" | "FETCHING_DATA" | "ANALYZING" | "GENERATING_INSIGHTS" | "COMPLETED" | "FAILED";

export interface AnalysisJobView {
  jobId: string;
  symbol: string;
  mode: "BUY" | "PORTFOLIO";
  status: JobStatus;
  stageDetail: string | null;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
  report: ResearchOutcome | null;
  error: string | null;
}

/** Start a background analysis; resolves immediately with the job handle. */
export async function startAnalysis(symbol: string, mode: "BUY" | "PORTFOLIO", question?: string): Promise<{ jobId: string; status: JobStatus }> {
  return apiRequest<{ jobId: string; status: JobStatus }>(`/ai/stock/${encodeURIComponent(symbol)}/analyze`, {
    method: "POST",
    body: JSON.stringify({ mode, question }),
  });
}

/** Poll one job's status/result. */
export async function getAnalysisJob(jobId: string): Promise<AnalysisJobView> {
  return apiRequest<AnalysisJobView>(`/ai/stock/jobs/${encodeURIComponent(jobId)}`);
}

/** Most recent job for a symbol (any state) — powers the resume-on-return view. */
export async function getLatestAnalysis(symbol: string, mode?: "BUY" | "PORTFOLIO"): Promise<AnalysisJobView | null> {
  const params = new URLSearchParams({ symbol });
  if (mode) params.set("mode", mode);
  return apiRequest<AnalysisJobView | null>(`/ai/stock/jobs/latest?${params.toString()}`);
}
