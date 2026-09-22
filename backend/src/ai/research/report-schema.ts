/**
 * Research report validation (Prompt 4).
 *
 * The research response is a COLLABORATION: the deterministic engine produces
 * recommendation/factors/confidence (never sent through the LLM), while the
 * model produces the narrative sections validated here. A malformed response
 * becomes a typed failure — never a crash and never a fabricated section.
 */

import { z } from "zod";

const s = (max: number) => z.string().transform((v) => v.trim().slice(0, max));

export const researchLlmSchema = z.object({
  executive_summary: s(1200),
  current_situation: s(1200),
  financial_analysis: z.object({
    summary: s(900),
    positive_factors: z.array(s(220)).max(8).default([]),
    negative_factors: z.array(s(220)).max(8).default([]),
    valuation: s(500),
  }),
  performance_analysis: z.object({
    summary: s(700),
    relative_to_benchmark: s(500),
  }),
  risk_analysis: z.object({ summary: s(700) }),
  news_analysis: z.object({
    summary: s(700),
    overall_direction: z.enum(["POSITIVE", "NEGATIVE", "MIXED", "NEUTRAL", "UNCERTAIN"]).default("UNCERTAIN"),
    important_events: z.array(s(240)).max(6).default([]),
    positive_factors: z.array(s(220)).max(6).default([]),
    negative_factors: z.array(s(220)).max(6).default([]),
  }),
  sector_macro_analysis: z.object({ summary: s(700), factors: z.array(s(200)).max(6).default([]) }),
  historical_context: z.object({ summary: s(600) }),
  scenarios: z.object({
    bull: z.object({ narrative: s(500), drivers: z.array(s(200)).max(5).default([]), invalidators: z.array(s(200)).max(5).default([]) }),
    base: z.object({ narrative: s(500), drivers: z.array(s(200)).max(5).default([]), invalidators: z.array(s(200)).max(5).default([]) }),
    bear: z.object({ narrative: s(500), drivers: z.array(s(200)).max(5).default([]), invalidators: z.array(s(200)).max(5).default([]) }),
  }),
  what_to_watch: z.array(s(220)).max(8).default([]),
  decision_reasoning: z.array(s(300)).max(10).default([]),
  limitations: z.array(s(220)).max(8).default([]),
});

export type ResearchLlmSections = z.infer<typeof researchLlmSchema>;

export class ResearchOutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResearchOutputError";
  }
}

export function parseResearchSections(raw: string): ResearchLlmSections {
  let text = raw.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) text = fence[1].trim();
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first >= 0 && last > first) text = text.slice(first, last + 1);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    try {
      parsed = JSON.parse(text.replace(/,\s*([}\]])/g, "$1"));
    } catch {
      throw new ResearchOutputError("research response was not valid JSON");
    }
  }
  const result = researchLlmSchema.safeParse(parsed);
  if (!result.success) {
    throw new ResearchOutputError(`research response failed validation: ${result.error.issues[0]?.message ?? "unknown"}`);
  }
  return result.data;
}
