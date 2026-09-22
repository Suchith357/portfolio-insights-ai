/**
 * Embedding client (PortfolioIQ AI foundation).
 *
 * Talks to a local, OpenAI-compatible embedding endpoint served by Ollama
 * (default model: Qwen3-Embedding-0.6B — 1024-dim, ~0.8 GB VRAM). All
 * failures are wrapped in EmbeddingError so callers can degrade gracefully;
 * nothing here can crash the backend.
 */

import { aiConfig } from "./config.js";

export class EmbeddingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmbeddingError";
  }
}

/** Probe the local model server quickly (used for status + readiness). */
export async function probeServer(): Promise<{ reachable: boolean; models: string[] }> {
  try {
    const res = await fetch(`${aiConfig.ollamaBaseUrl}/api/tags`, {
      signal: AbortSignal.timeout(aiConfig.probeTimeoutMs),
    });
    if (!res.ok) return { reachable: false, models: [] };
    const body = (await res.json()) as { models?: Array<{ name?: string }> };
    return {
      reachable: true,
      models: (body.models ?? []).map((m) => String(m.name ?? "")).filter(Boolean),
    };
  } catch {
    return { reachable: false, models: [] };
  }
}

/** True when both the LLM and embedding models are pulled in the runtime. */
export async function requiredModelsPresent(): Promise<{ ok: boolean; missing: string[]; models: string[] }> {
  const { reachable, models } = await probeServer();
  if (!reachable) return { ok: false, missing: [aiConfig.llmModel, aiConfig.embeddingModel], models: [] };
  const has = (name: string) => models.some((m) => m === name || m.startsWith(`${name}:`));
  const missing = [aiConfig.embeddingModel, aiConfig.llmModel].filter((m) => !has(m));
  return { ok: missing.length === 0, missing, models };
}

/** Embed one text. Returns a vector normalised to unit length. */
export async function embedOne(text: string): Promise<number[]> {
  const vecs = await embedMany([text]);
  const vec = vecs[0];
  if (!vec) throw new EmbeddingError("Embedding server returned no vector for the query.");
  return vec;
}

/** Embed a batch of texts with unit-length normalisation (cosine-ready). */
export async function embedMany(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const trimmed = texts.map((t) => (t ?? "").slice(0, 8000));
  let res: Response;
  try {
    res = await fetch(`${aiConfig.ollamaBaseUrl}/api/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: aiConfig.embeddingModel, input: trimmed }),
      signal: AbortSignal.timeout(aiConfig.llmTimeoutMs),
    });
  } catch (err) {
    throw new EmbeddingError(`Embedding server unreachable at ${aiConfig.ollamaBaseUrl}: ${(err as Error).message}`);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new EmbeddingError(`Embedding request failed (HTTP ${res.status}): ${body.slice(0, 200)}`);
  }
  const parsed = (await res.json()) as { embeddings?: number[][] };
  const embeddings = parsed.embeddings;
  if (!Array.isArray(embeddings) || embeddings.length !== trimmed.length) {
    throw new EmbeddingError("Embedding server returned an unexpected payload shape.");
  }
  return embeddings.map(normalise);
}

function normalise(vec: number[]): number[] {
  if (!Array.isArray(vec) || vec.length === 0 || vec.some((v) => typeof v !== "number" || !Number.isFinite(v))) {
    throw new EmbeddingError("Embedding server returned an invalid vector.");
  }
  let sumSq = 0;
  for (const v of vec) sumSq += v * v;
  const norm = Math.sqrt(sumSq);
  if (norm === 0) return vec;
  return vec.map((v) => v / norm);
}
