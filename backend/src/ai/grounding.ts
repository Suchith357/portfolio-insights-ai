/**
 * Grounding layer (PortfolioIQ AI foundation).
 *
 * Decides whether retrieval quality is good enough to answer, and builds the
 * evidence block for the prompt. Hard rules:
 *   - no evidence above threshold → INSUFFICIENT_EVIDENCE, no LLM call
 *   - evidence is truncated to a bounded character budget
 *   - every evidence row carries source + provenance for citation
 */

import { aiConfig } from "./config.js";
import type { RetrievedEvidence, GroundedQueryResult } from "./types.js";

export type GroundingDecision =
  | { verdict: "PROCEED"; evidence: RetrievedEvidence[] }
  | { verdict: "INSUFFICIENT"; evidence: RetrievedEvidence[]; reason: string };

/**
 * Evaluate retrieval quality. The deterministic bar:
 *   - at least one document at/above the minimum similarity, AND
 *   - enough aggregate signal (sum of top scores) to suggest topical overlap.
 */
export function evaluateRetrieval(evidence: RetrievedEvidence[], minScore = aiConfig.minScore): GroundingDecision {
  if (evidence.length === 0) {
    return {
      verdict: "INSUFFICIENT",
      evidence: [],
      reason: "Insufficient retrieved evidence — no document met the minimum relevance threshold for this question.",
    };
  }
  const aggregate = evidence.slice(0, 3).reduce((s, e) => s + e.score, 0);
  const best = evidence[0];
  if (aggregate < minScore * 1.5 && best && best.score < minScore + 0.1) {
    return {
      verdict: "INSUFFICIENT",
      evidence,
      reason: "Insufficient retrieved evidence — the closest documents were only weakly related to the question.",
    };
  }
  return { verdict: "PROCEED", evidence };
}

/**
 * Build the numbered evidence block injected into the prompt. Each entry is
 * labelled with its document id so the model can cite evidence by number and
 * the response validator can verify citations exist.
 */
export function buildEvidenceBlock(evidence: RetrievedEvidence[], budgetChars = aiConfig.maxEvidenceChars): string {
  const lines: string[] = [];
  let used = 0;
  for (let i = 0; i < evidence.length; i++) {
    const e = evidence[i];
    if (!e) break;
    const metaBits = [
      e.documentType,
      e.source,
      e.stockSymbol ? `symbol ${e.stockSymbol}` : null,
      e.publishedAt ? `published ${e.publishedAt.slice(0, 10)}` : null,
    ]
      .filter(Boolean)
      .join(" | ");
    const entry = `[E${i + 1}] (${metaBits})\n${e.title}\n${e.snippet}`;
    if (used + entry.length > budgetChars) break;
    lines.push(entry);
    used += entry.length;
  }
  return lines.join("\n\n");
}

/** Shared refusal text used whenever the model must not answer. */
export function insufficientEvidenceResult(
  evidence: RetrievedEvidence[],
  reason: string,
  retrievalMs: number,
  documentsIndexed: number,
): Extract<GroundedQueryResult, { grounding: "INSUFFICIENT_EVIDENCE" }> {
  return {
    grounding: "INSUFFICIENT_EVIDENCE",
    unavailableReason: reason,
    evidence,
    meta: {
      topK: aiConfig.topK,
      minScore: aiConfig.minScore,
      retrievalMs,
      generationMs: null,
      model: aiConfig.llmModel,
      documentsIndexed,
    },
  };
}
