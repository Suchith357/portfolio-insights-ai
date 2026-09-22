/**
 * AI event analysis (Prompt 2+3, Feature B) — maps to /api/ai/event/:id/analyze.
 * The backend gates the LLM behind deterministic importance + grounding; the
 * response always includes a reason when the model was not used.
 */
import { apiRequest } from "./api-client";

export interface EventAiAssessment {
  eventSummary: string;
  affectedStock: string | null;
  direction: "POSITIVE" | "NEGATIVE" | "MIXED" | "NEUTRAL" | "UNCERTAIN";
  importance: "WATCH" | "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  portfolioExposurePct: number | null;
  keyFactors: string[];
  portfolioImpact: string;
  whyItMatters: string;
  whatToMonitor: string[];
  confidence: number;
  evidence: Array<{ evidenceId: string; title: string; source: string; url: string | null }>;
  sources: string[];
  recommendation: string;
}

export interface AnalyzeOutcome {
  ran: boolean;
  reason: string;
  assessment: EventAiAssessment | null;
  grounding: "GROUNDED" | "INSUFFICIENT_EVIDENCE" | "UNAVAILABLE" | "SKIPPED";
}

export async function analyzeEvent(eventId: string): Promise<AnalyzeOutcome> {
  return apiRequest<AnalyzeOutcome>(`/ai/event/${eventId}/analyze`, { method: "POST" });
}
