/**
 * Structured output validation (PortfolioIQ AI foundation).
 *
 * The LLM is asked for strict JSON. Real models sometimes misbehave, so every
 * response passes through: fence-stripping → JSON.parse → Zod → sanitisation
 * (bounded strings, finite numbers, deduped arrays). A malformed response
 * becomes a typed failure — never a crash and never silently trusted content.
 */

import { z } from "zod";

const boundedString = (max: number) => z.string().transform((s) => s.trim().slice(0, max));

export const structuredAnalysisSchema = z.object({
  analysis: boundedString(4000).refine((s) => s.length > 0, { message: "analysis must not be empty" }),
  key_factors: z.array(boundedString(300)).max(12).default([]),
  positive_factors: z.array(boundedString(300)).max(12).default([]),
  negative_factors: z.array(boundedString(300)).max(12).default([]),
  risk_assessment: boundedString(1500).default("Not assessable from current evidence."),
  uncertainty: boundedString(1500).default("Not stated by the model."),
  evidence: z
    .array(
      z.object({
        documentId: boundedString(200),
        title: boundedString(400),
        source: boundedString(200),
      }),
    )
    .max(12)
    .default([]),
  confidence: z.coerce.number().min(0).max(1).default(0.3),
});

export type StructuredAnalysisParsed = z.infer<typeof structuredAnalysisSchema>;

export class LlmOutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LlmOutputError";
  }
}

/** Strip markdown fences and surrounding prose some models add despite instructions. */
export function extractJsonBlock(raw: string): string {
  let text = raw.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) text = fence[1].trim();
  // If the model wrapped JSON in prose, take the outermost brace block.
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first >= 0 && last > first) text = text.slice(first, last + 1);
  return text;
}

export function parseStructuredAnalysis(raw: string): StructuredAnalysisParsed {
  let jsonText = extractJsonBlock(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    // One repair attempt: strip trailing commas (common LLM slip).
    jsonText = jsonText.replace(/,\s*([}\]])/g, "$1");
    try {
      parsed = JSON.parse(jsonText);
    } catch {
      throw new LlmOutputError("LLM response was not valid JSON.");
    }
  }
  const result = structuredAnalysisSchema.safeParse(parsed);
  if (!result.success) {
    throw new LlmOutputError(`LLM response failed schema validation: ${result.error.issues[0]?.message ?? "unknown"}`);
  }
  return result.data;
}
