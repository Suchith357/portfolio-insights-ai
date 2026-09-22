/**
 * AI service orchestrator (PortfolioIQ AI foundation).
 *
 *   query → retrieve → ground → prompt → Qwen3-4B → validate → respond
 *
 * Graceful degradation contract: when the module is disabled, the runtime is
 * misconfigured, the model server is down, or the index is missing, the
 * service returns an UNAVAILABLE result with a reason — the rest of
 * PortfolioIQ never depends on this layer to function.
 */

import { aiConfig, validateAiConfig } from "./config.js";
import { retrieve } from "./retriever.js";
import { evaluateRetrieval, insufficientEvidenceResult } from "./grounding.js";
import { buildPrompt, type PromptKind } from "./prompts.js";
import { chat, LlmError } from "./llm.js";
import { parseStructuredAnalysis, LlmOutputError } from "./output-schema.js";
import { requiredModelsPresent } from "./embedding.js";
import { vectorStore } from "./vector-store.js";
import { indexStatus } from "./indexer.js";
import type { GroundedQueryResult, AiStatus } from "./types.js";

export interface QueryInput {
  question: string;
  kind?: PromptKind;
  /** Stock-scoped retrieval (symbol from our covered universe). */
  stockSymbol?: string;
  /** Event-scoped retrieval. */
  eventId?: number;
  topK?: number;
  /** Structured quantitative facts computed by the analytics engine. */
  quantitativeFacts?: string[];
}

export async function query(input: QueryInput): Promise<GroundedQueryResult> {
  const validation = validateAiConfig();
  if (!aiConfig.enabled || aiConfig.runtime === "NONE") {
    return unavailable("The AI module is disabled by configuration (AI_ENABLED/AI_RUNTIME).", 0);
  }
  if (!validation.valid) {
    return unavailable(`AI configuration is invalid: ${validation.problems.join("; ")}`, 0);
  }

  const question = input.question.trim().slice(0, 1000);
  if (question.length < 3) {
    return unavailable("Question is too short to analyse.", 0);
  }

  const status = await getStatus();
  if (!status.embeddingServerReachable) {
    return unavailable(
      "The local AI runtime is unreachable. Start Ollama (models: qwen3:4b-instruct + qwen3-embedding:0.6b) and try again. PortfolioIQ works fully without it.",
      0,
    );
  }
  if (!vectorStore.exists || vectorStore.size === 0) {
    vectorStore.ensureLoaded(); // restart resilience: hydrate the persisted index before declaring it empty
  }
  if (!vectorStore.exists || vectorStore.size === 0) {
    return unavailable(
      "The AI knowledge index is empty. An administrator must build it first (POST /api/admin/ai/index/rebuild).",
      0,
    );
  }
  const models = await requiredModelsPresent();
  if (!models.ok) {
    return unavailable(`Required models are missing from the local runtime: ${models.missing.join(", ")}.`, 0);
  }

  // 1) RETRIEVE
  const retrieval = await retrieve(question, {
    topK: input.topK,
    stockSymbol: input.stockSymbol,
    eventId: input.eventId,
  });
  if (retrieval.failed) {
    return unavailable(`Retrieval failed: ${retrieval.failureReason ?? "unknown error"}`, retrieval.retrievalMs);
  }

  // 2) GROUND
  const decision = evaluateRetrieval(retrieval.evidence);
  if (decision.verdict === "INSUFFICIENT") {
    return insufficientEvidenceResult(decision.evidence, decision.reason, retrieval.retrievalMs, vectorStore.size);
  }

  // 3) PROMPT + GENERATE
  const prompt = buildPrompt({ kind: input.kind ?? "general_qa", question, evidence: decision.evidence, quantitativeFacts: input.quantitativeFacts });
  const genStart = Date.now();
  let raw: string;
  try {
    raw = await chat(prompt.system, prompt.user);
  } catch (err) {
    const reason = err instanceof LlmError ? err.message : "LLM generation failed";
    console.error(`[ai:service] generation failed: ${reason}`);
    return {
      grounding: "UNAVAILABLE",
      unavailableReason: reason,
      evidence: decision.evidence,
      meta: { ...meta(input.topK, retrieval.retrievalMs), generationMs: Date.now() - genStart },
    };
  }

  // 4) VALIDATE
  let analysis;
  try {
    analysis = parseStructuredAnalysis(raw);
  } catch (err) {
    const reason = err instanceof LlmOutputError ? err.message : "LLM response could not be parsed";
    console.error(`[ai:service] ${reason}`);
    return {
      grounding: "UNAVAILABLE",
      unavailableReason: `The model produced a malformed response (${reason}). Please retry.`,
      evidence: decision.evidence,
      meta: { ...meta(input.topK, retrieval.retrievalMs), generationMs: Date.now() - genStart },
    };
  }

  return {
    grounding: "GROUNDED",
    evidence: decision.evidence,
    analysis: {
      ...analysis,
      evidence: analysis.evidence.map((e) => ({ ...e, sourceUrl: undefined })),
    },
    meta: { ...meta(input.topK, retrieval.retrievalMs), generationMs: Date.now() - genStart },
  };
}

function meta(topK?: number, retrievalMs = 0) {
  return {
    topK: topK ?? aiConfig.topK,
    minScore: aiConfig.minScore,
    retrievalMs,
    generationMs: null as number | null,
    model: aiConfig.llmModel,
    documentsIndexed: vectorStore.size,
  };
}

function unavailable(reason: string, retrievalMs: number): GroundedQueryResult {
  return { grounding: "UNAVAILABLE", unavailableReason: reason, evidence: [], meta: meta(undefined, retrievalMs) };
}

/** Coarse availability for /api/ai/status and admin diagnostics. */
export async function getStatus(): Promise<AiStatus> {
  const validation = validateAiConfig();
  const models = await requiredModelsPresent();
  const idx = indexStatus();
  let availability: AiStatus["availability"];
  let detail: string;
  if (!aiConfig.enabled || aiConfig.runtime === "NONE") {
    availability = "DISABLED";
    detail = "AI module disabled by configuration.";
  } else if (!validation.valid) {
    availability = "UNAVAILABLE";
    detail = `Configuration invalid: ${validation.problems.join("; ")}`;
  } else if (!models.models.length) {
    availability = "UNAVAILABLE";
    detail = "Local model server unreachable — start Ollama to enable AI features. PortfolioIQ works fully without it.";
  } else if (!idx.indexExists || idx.documentsIndexed === 0) {
    availability = "DEGRADED";
    detail = "Model server reachable but the knowledge index is empty — run an index rebuild (admin).";
  } else if (models.missing.length > 0) {
    availability = "DEGRADED";
    detail = `Index ready; missing models: ${models.missing.join(", ")}.`;
  } else {
    availability = "READY";
    detail = "AI module ready (retrieval + generation available).";
  }
  return {
    availability,
    runtime: aiConfig.runtime,
    llmModel: aiConfig.llmModel,
    embeddingModel: aiConfig.embeddingModel,
    quantization: aiConfig.quantization,
    documentsIndexed: idx.documentsIndexed,
    indexExists: idx.indexExists,
    lastIndexedAt: idx.lastIndexedAt,
    embeddingServerReachable: models.models.length > 0,
    detail,
  };
}
