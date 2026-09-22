/**
 * AI/RAG configuration (PortfolioIQ AI foundation).
 *
 * Every value is environment-driven with a documented default. No secrets and
 * no machine-specific absolute paths live here: the FAISS index and metadata
 * store resolve to `<project>/backend/data/ai/` by default and can be
 * relocated through AI_DATA_DIR.
 */

function num(name: string, fallback: number, min: number, max: number): number {
  const raw = Number(process.env[name]);
  if (!Number.isFinite(raw)) return fallback;
  return Math.min(max, Math.max(min, raw));
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (raw === undefined || raw === "") return fallback;
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

import path from "node:path";
import fs from "node:fs";

/**
 * Data directory for AI artifacts (FAISS index + metadata store).
 * Default: <backend root>/data/ai — gitignored, never committed.
 * Resolved relative to this module so no absolute path is baked in.
 */
function defaultDataDir(): string {
  // src/ai/config.ts → backend root is two levels up after compilation too
  // (dist/ai/config.js → dist/.. == backend root).
  const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
  const backendRoot = path.resolve(here, "..", "..");
  return path.join(backendRoot, "data", "ai");
}

export const aiConfig = {
  /** Master switch — with AI_ENABLED=false the module is inert and free. */
  enabled: bool("AI_ENABLED", true),

  /** Runtime: "OLLAMA" is implemented; "NONE" disables remote model calls. Read dynamically so tests/env changes apply. */
  get runtime(): string {
    return (process.env["AI_RUNTIME"] ?? "OLLAMA").toUpperCase();
  },

  /** Base URL of the Ollama-compatible local server (localhost only by default). */
  ollamaBaseUrl: process.env["AI_OLLAMA_BASE_URL"] ?? "http://127.0.0.1:11434",

  /** Generative LLM — Qwen3-4B-Instruct in 4-bit quantization (2.5 GB on disk, ~4.5 GB VRAM at ctx 4096). */
  llmModel: process.env["AI_LLM_MODEL"] ?? "qwen3:4b-instruct-2507-q4_K_M",
  /** Embedding model — Qwen3-Embedding-0.6B (620 MB on disk, ~0.8 GB VRAM). */
  embeddingModel: process.env["AI_EMBEDDING_MODEL"] ?? "qwen3-embedding:0.6b",
  /** Quantization label, informational — recorded in status/logs. */
  quantization: process.env["AI_LLM_QUANTIZATION"] ?? "q4_K_M",

  /** Generation parameters. Lower temperature keeps the model grounded. */
  contextLength: num("AI_LLM_CONTEXT_LENGTH", 4096, 512, 32_768),
  temperature: num("AI_LLM_TEMPERATURE", 0.2, 0, 1),
  maxOutputTokens: num("AI_LLM_MAX_TOKENS", 1536, 64, 4096),
  /** Hard wall-clock budget for one LLM completion. */
  llmTimeoutMs: num("AI_LLM_TIMEOUT_MS", 90_000, 10_000, 300_000),

  /** Retrieval tuning. */
  topK: num("AI_RAG_TOP_K", 6, 1, 25),
  minScore: num("AI_RAG_MIN_SCORE", 0.35, 0, 1),
  /** Max evidence characters passed to the LLM (keeps context bounded). */
  maxEvidenceChars: num("AI_RAG_MAX_EVIDENCE_CHARS", 6000, 500, 30_000),

  /** Vector index artifacts. */
  indexFilename: "documents.faiss",
  metadataFilename: "documents.json",
  /** Embedding dimensionality of Qwen3-Embedding-0.6B. */
  embeddingDim: 1024,

  get dataDir(): string {
    const custom = process.env["AI_DATA_DIR"]?.trim();
    return custom && custom.length > 0 ? custom : defaultDataDir();
  },

  get indexPath(): string {
    return path.join(this.dataDir, this.indexFilename);
  },

  get metadataPath(): string {
    return path.join(this.dataDir, this.metadataFilename);
  },

  ensureDataDir(): void {
    fs.mkdirSync(this.dataDir, { recursive: true });
  },

  /** Deeper readiness probe timeouts (server might be booting the model). */
  probeTimeoutMs: num("AI_PROBE_TIMEOUT_MS", 1_500, 250, 15_000),
};

export type AiRuntime = "OLLAMA" | "NONE";

/** Coarse validation at startup; problems are reported, never thrown in a route. */
export function validateAiConfig(): { valid: boolean; problems: string[] } {
  const problems: string[] = [];
  if (aiConfig.topK < aiConfig.minScore * 0 || aiConfig.topK <= 0) problems.push("AI_RAG_TOP_K must be >= 1");
  if (aiConfig.minScore < 0 || aiConfig.minScore > 1) problems.push("AI_RAG_MIN_SCORE must be within [0, 1]");
  if (aiConfig.temperature < 0 || aiConfig.temperature > 1) problems.push("AI_LLM_TEMPERATURE must be within [0, 1]");
  if (aiConfig.embeddingDim <= 0) problems.push("embedding dimension must be positive");
  if (aiConfig.runtime !== "OLLAMA" && aiConfig.runtime !== "NONE") {
    problems.push(`AI_RUNTIME must be OLLAMA or NONE (got ${aiConfig.runtime})`);
  }
  return { valid: problems.length === 0, problems };
}
