/**
 * Embedding client (PortfolioIQ AI foundation).
 *
 * Two interchangeable runtimes behind one API:
 *
 *  - OLLAMA (local dev): Ollama /api/embed with Qwen3-Embedding-0.6B (1024-d).
 *  - OPENROUTER (hosted, e.g. Render): POST {base}/embeddings with an
 *    OpenAI-compatible {model, input} payload; response {data:[{embedding}]}.
 *    The API key lives ONLY in the Bearer header (read from backend env, never
 *    logged or returned). Output dimensionality is DISCOVERED from the first
 *    response and recorded in config, because OpenRouter's catalog does not
 *    publish dims for the free embedding models; the vector store stamps
 *    model+dim into its metadata so mixed-geometry indexes are never searched.
 *
 * All failures are wrapped in EmbeddingError so callers degrade gracefully;
 * nothing here can crash the backend.
 */

import { aiConfig } from "./config.js";

export class EmbeddingError extends Error {
  readonly kind: "AUTH" | "RATE_LIMIT" | "UNAVAILABLE" | "SHAPE" | "SERVER";

  constructor(message: string, kind: "AUTH" | "RATE_LIMIT" | "UNAVAILABLE" | "SHAPE" | "SERVER" = "UNAVAILABLE") {
    super(message);
    this.name = "EmbeddingError";
    this.kind = kind;
  }
}

/** OpenRouter probe result caching — /key is metadata, not a model request, but avoid per-call cost anyway. */
let openrouterProbe: { at: number; result: { reachable: boolean; models: string[]; reason?: string } } | null = null;
const PROBE_TTL_MS = 60_000;

/** Test hook: drop the cached probe so a stubbed fetch is honoured immediately. */
export function __clearProbeCacheForTest(): void {
  openrouterProbe = null;
}

/** Probe the model server quickly (used for status + readiness gates). */
export async function probeServer(): Promise<{ reachable: boolean; models: string[]; reason?: string }> {
  if (aiConfig.runtime === "OPENROUTER") {
    if (openrouterProbe && Date.now() - openrouterProbe.at < PROBE_TTL_MS) return openrouterProbe.result;
    const result = await probeOpenRouter();
    openrouterProbe = { at: Date.now(), result };
    return result;
  }
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

async function probeOpenRouter(): Promise<{ reachable: boolean; models: string[]; reason?: string }> {
  const apiKey = aiConfig.openrouterApiKey;
  if (!apiKey) return { reachable: false, models: [], reason: "OPENROUTER_API_KEY is not set on the server." };
  try {
    // GET /key is the lightweight credential check (account metadata, not a
    // model request and not counted against free-model request quotas).
    const res = await fetch(`${aiConfig.openrouterBaseUrl}/key`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(aiConfig.probeTimeoutMs),
    });
    if (res.status === 401 || res.status === 403) {
      return { reachable: false, models: [], reason: "OpenRouter rejected the server's API credentials." };
    }
    if (!res.ok) return { reachable: false, models: [], reason: `OpenRouter is unreachable (HTTP ${res.status}).` };
    return { reachable: true, models: [aiConfig.openrouterEmbeddingModel, aiConfig.openrouterModel] };
  } catch {
    return { reachable: false, models: [], reason: "OpenRouter is unreachable right now." };
  }
}

/**
 * True when both models of the active runtime are usable. On OLLAMA both
 * names must be pulled; on OPENROUTER a valid key suffices (models are
 * hosted and named by configuration).
 */
export async function requiredModelsPresent(): Promise<{ ok: boolean; missing: string[]; models: string[] }> {
  if (aiConfig.runtime === "OPENROUTER") {
    const probe = await probeServer();
    if (!probe.reachable) return { ok: false, missing: [aiConfig.openrouterModel, aiConfig.openrouterEmbeddingModel], models: [] };
    return { ok: true, missing: [], models: probe.models };
  }
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
  const raw = aiConfig.runtime === "OPENROUTER" ? await openrouterEmbed(trimmed) : await ollamaEmbed(trimmed);
  return raw.map(normalise);
}

async function ollamaEmbed(trimmed: string[]): Promise<number[][]> {
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
    throw new EmbeddingError(`Embedding request failed (HTTP ${res.status}): ${body.slice(0, 200)}`, "SERVER");
  }
  const parsed = (await res.json()) as { embeddings?: number[][] };
  const embeddings = parsed.embeddings;
  if (!Array.isArray(embeddings) || embeddings.length !== trimmed.length) {
    throw new EmbeddingError("Embedding server returned an unexpected payload shape.", "SHAPE");
  }
  return embeddings;
}

async function openrouterEmbed(trimmed: string[]): Promise<number[][]> {
  const apiKey = aiConfig.openrouterApiKey;
  if (!apiKey) throw new EmbeddingError("The hosted embedding provider is not configured on the server (OPENROUTER_API_KEY is missing).", "UNAVAILABLE");
  let res: Response;
  try {
    res = await fetch(`${aiConfig.openrouterBaseUrl}/embeddings`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://portfolio-insights-ai-zeta.vercel.app",
        "X-Title": "PortfolioIQ",
      },
      body: JSON.stringify({ model: aiConfig.openrouterEmbeddingModel, input: trimmed }),
      signal: AbortSignal.timeout(aiConfig.llmTimeoutMs),
    });
  } catch (err) {
    throw new EmbeddingError(`Hosted embedding provider unreachable: ${(err as Error).message}`);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    if (res.status === 401 || res.status === 403) throw new EmbeddingError("OpenRouter rejected the server's API credentials (HTTP 4xx auth).", "AUTH");
    if (res.status === 429 || res.status === 402) throw new EmbeddingError(`OpenRouter free-tier embedding quota is exhausted (HTTP ${res.status}) — try again later.`, "RATE_LIMIT");
    if (res.status === 404) throw new EmbeddingError(`OpenRouter cannot serve embedding model ${aiConfig.openrouterEmbeddingModel} (HTTP 404 — set OPENROUTER_EMBEDDING_MODEL to an available model).`, "UNAVAILABLE");
    throw new EmbeddingError(`Embedding request failed (HTTP ${res.status}): ${body.slice(0, 160)}`, "SERVER");
  }
  const parsed = (await res.json()) as { data?: Array<{ embedding?: number[]; index?: number }>; error?: unknown };
  const data = parsed.data;
  if (parsed.error || !Array.isArray(data) || data.length !== trimmed.length || data.some((d) => !Array.isArray(d.embedding))) {
    throw new EmbeddingError("OpenRouter returned an unexpected embedding payload shape.", "SHAPE");
  }
  // The embeddings endpoint preserves input order (OpenAI-compatible); direct
  // mapping would be fine here, but index-sorting makes the contract explicit.
  const ordered = [...data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0)).map((d) => d.embedding as number[]);
  const firstLen = ordered[0]?.length ?? 0;
  if (firstLen > 0) aiConfig.noteEmbeddingDiscovered(firstLen);
  return ordered;
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
