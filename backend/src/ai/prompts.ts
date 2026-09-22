/**
 * Prompt architecture (PortfolioIQ AI foundation).
 *
 * Prompts are COMPOSED from layers — system, analyst role, grounding rules,
 * evidence block, user question — never hard-coded inside a route. New prompt
 * kinds (buy-analysis, alert-analysis, scenario, …) are added by registering
 * another template, not by editing the pipeline.
 */

import { buildEvidenceBlock } from "./grounding.js";
import type { RetrievedEvidence, StructuredAnalysis } from "./types.js";

export type PromptKind =
  | "general_qa" // implemented now
  | "stock_analysis" // registered for later phases
  | "buy_analysis"
  | "portfolio_news_analysis"
  | "alert_analysis"
  | "performance_analysis"
  | "scenario_analysis";

export interface PromptLayerInput {
  kind: PromptKind;
  question: string;
  evidence: RetrievedEvidence[];
  /** Structured quantitative facts the model must quote, never recompute. */
  quantitativeFacts?: string[];
}

const SYSTEM_INSTRUCTIONS = `You are PortfolioIQ's financial research assistant — a decision-SUPPORT tool for an Indian equity portfolio platform. You are not a licensed advisor and you never give investment instructions.`;

const ANALYST_INSTRUCTIONS = `Analyst rules:
- Explain and interpret; do not calculate. Every number you mention must come from the evidence or the quantitative facts provided to you. If a figure is not present, say it is not available — never estimate or invent one.
- Distinguish clearly between FACTS (from evidence) and INTERPRETATION (your reading of them).
- State uncertainty explicitly. You never claim certainty about future stock prices.
- Do not predict prices, do not recommend buying or selling, and do not imply guaranteed outcomes.
- Prefer Indian-market context (NSE, ₹) where relevant.`;

const GROUNDING_INSTRUCTIONS = `Grounding rules:
- Use ONLY the supplied evidence for factual claims about news, events, companies or metrics.
- Cite evidence by its [E1], [E2] … label when you rely on it.
- If the evidence does not answer the question, say so plainly in "analysis" and set "confidence" low. Do not pad with generalities presented as fact.`;

const OUTPUT_CONTRACT = `Respond with ONLY a JSON object — no markdown fence, no commentary — with exactly these fields:
{
  "analysis": string,               // 2–6 sentences answering the question from the evidence
  "key_factors": string[],          // the factors that matter, each traceable to evidence
  "positive_factors": string[],     // possibly empty
  "negative_factors": string[],     // possibly empty
  "risk_assessment": string,        // what the evidence says about risk, or "Not assessable from current evidence."
  "uncertainty": string,            // what is unknown or unverifiable here
  "evidence": [{"documentId": string, "title": string, "source": string}],  // the [E#] items you actually used
  "confidence": number              // 0 to 1: how well the evidence covered the question
}`;

const KIND_SPECIFICS: Record<PromptKind, string> = {
  general_qa: `Task: answer the user's financial question using the evidence.`,
  stock_analysis: `Task: analyse the stock in question using the evidence.`,
  buy_analysis: `Task: assess the stock as a research candidate using the evidence. Do NOT output a BUY/HOLD/AVOID verdict — describe what the evidence supports and what is unknown.`,
  portfolio_news_analysis: `Task: explain how the news/evidence relates to the user's portfolio exposure as described in the quantitative facts.`,
  alert_analysis: `Task: explain why this alert was generated using the evidence.`,
  performance_analysis: `Task: interpret the performance numbers supplied in the quantitative facts; never recompute them.`,
  scenario_analysis: `Task: interpret the hypothetical scenario results supplied in the quantitative facts; remind the user that scenarios are what-if analyses, not predictions.`,
};

export function buildPrompt(input: PromptLayerInput): { system: string; user: string } {
  const system = [SYSTEM_INSTRUCTIONS, ANALYST_INSTRUCTIONS, GROUNDING_INSTRUCTIONS, OUTPUT_CONTRACT, KIND_SPECIFICS[input.kind]].join("\n\n");

  const facts = input.quantitativeFacts?.length
    ? `Quantitative facts (computed by the analytics engine — authoritative, do not recompute):\n${input.quantitativeFacts.map((f) => `- ${f}`).join("\n")}`
    : "";
  const evidenceBlock = buildEvidenceBlock(input.evidence);
  const user = [
    facts,
    evidenceBlock ? `Evidence:\n${evidenceBlock}` : "",
    `Question: ${input.question}`,
  ]
    .filter(Boolean)
    .join("\n\n");

  return { system, user };
}

/** Helper used by tests and by the response validator to know expected ids. */
export function evidenceIds(evidence: RetrievedEvidence[]): string[] {
  return evidence.map((e) => e.documentId);
}
