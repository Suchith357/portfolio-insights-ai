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
  readonly isDailyQuotaExhausted: boolean;
  readonly retryAfterMs: number | null;

  constructor(
    message: string,
    kind: "AUTH" | "RATE_LIMIT" | "UNAVAILABLE" | "SHAPE" | "SERVER" = "UNAVAILABLE",
    isDailyQuotaExhausted = false,
    retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = "EmbeddingError";
    this.kind = kind;
    this.isDailyQuotaExhausted = isDailyQuotaExhausted;
    this.retryAfterMs = retryAfterMs;
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
  return { ok: missing.length === 0, missing, models: models };
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

function classifyEmbeddingError(status: number, bodyText: string, headers?: Headers): EmbeddingError {
  let detail = "";
  try {
    const body = JSON.parse(bodyText) as { error?: { message?: string; code?: number } | string };
    if (typeof body.error === "string") {
      detail = body.error;
    } else if (body.error && typeof body.error === "object") {
      detail = typeof body.error.message === "string" ? body.error.message : "";
    }
  } catch {
    detail = bodyText.slice(0, 200);
  }
  const combined = (detail).toLowerCase();
  const isDailyQuotaExhausted =
    combined.includes("daily") ||
    combined.includes("day limit") ||
    combined.includes("quota") && combined.includes("exhaust") ||
    combined.includes("credits exhausted") ||
    combined.includes("account") && combined.includes("quota");

  const retryAfterHeader = headers?.get("Retry-After");
  const retryAfterParsed = retryAfterHeader ? Number(retryAfterHeader) : NaN;
  const retryAfterMs = Number.isFinite(retryAfterParsed) && retryAfterParsed > 0 ? retryAfterParsed * 1000 : null;

  if (status === 401 || status === 403) {
    return new EmbeddingError("OpenRouter rejected the server's API credentials (HTTP 4xx auth).", "AUTH");
  }
  if (status === 429 || status === 402) {
    if (isDailyQuotaExhausted) {
      return new EmbeddingError(
        `OpenRouter free-tier embedding daily/quota exhausted (HTTP ${status}) — account-wide limit reached.`,
        "RATE_LIMIT",
        true,
        retryAfterMs,
      );
    }
    return new EmbeddingError(
      `OpenRouter free-tier embedding quota or rate limit is exhausted (HTTP ${status}) — try again later.`,
      "RATE_LIMIT",
      false,
      retryAfterMs,
    );
  }
  if (status === 404) {
    return new EmbeddingError(`OpenRouter cannot serve embedding model (HTTP 404 — set OPENROUTER_EMBEDDING_MODEL to an available model).`, "UNAVAILABLE");
  }
  return new EmbeddingError(`Embedding request failed (HTTP ${status}): ${bodyText.slice(0, 160)}`, "SERVER");
}

async function embedWithModel(model: string, apiKey: string, trimmed: string[]): Promise<number[][]> {
  const MAX_ATTEMPTS = 3;
  let lastError: EmbeddingError = new EmbeddingError("OpenRouter embedding request failed.", "SERVER");

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
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
        body: JSON.stringify({ model, input: trimmed }),
        signal: AbortSignal.timeout(aiConfig.llmTimeoutMs),
      });
    } catch (err) {
      throw new EmbeddingError(`Hosted embedding provider unreachable: ${(err as Error).message}`);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      lastError = classifyEmbeddingError(res.status, body, res.headers);
      if (lastError.kind === "AUTH" || lastError.kind === "UNAVAILABLE" || lastError.kind === "SHAPE") {
        throw lastError;
      }
      if (lastError.kind === "RATE_LIMIT") {
        if (lastError.isDailyQuotaExhausted) {
          // Don't retry on daily/account-wide quota exhaustion
          throw lastError;
        }
        const waitMs = Math.min(30_000, lastError.retryAfterMs && lastError.retryAfterMs > 0 ? lastError.retryAfterMs : 12_000);
        if (attempt < MAX_ATTEMPTS) {
          await new Promise((r) => setTimeout(r, waitMs));
          continue;
        }
        throw lastError;
      }
      // SERVER errors - retry once
      if (attempt < MAX_ATTEMPTS) {
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }
      throw lastError;
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
  throw lastError;
}

async function openrouterEmbed(trimmed: string[]): Promise<number[][]> {
  const apiKey = aiConfig.openrouterApiKey;
  if (!apiKey) throw new EmbeddingError("The hosted embedding provider is not configured on the server (OPENROUTER_API_KEY is missing).", "UNAVAILABLE");

  const primaryModel = aiConfig.openrouterEmbeddingModel;
  const fallbackModel = aiConfig.embeddingModelFallback;

  try {
    return await embedWithModel(primaryModel, apiKey, trimmed);
  } catch (err) {
    if (!(err instanceof EmbeddingError)) throw err;
    // Fallback policy — mirrors chat(): only for failures specific to the
    // PRIMARY embedding model or its provider, never account-wide conditions:
    //   - RATE_LIMIT (transient 429/402): a per-minute/per-provider limit; a
    //     different model may still have headroom. Confirmed daily/account
    //     quota exhaustion (isDailyQuotaExhausted) → NO fallback, NO retries.
    //   - UNAVAILABLE (404 "model not found"): the configured model was delisted
    //     or is not served to this account — model-specific, try the secondary.
    //   - SERVER (persistent 5xx after in-call retries): provider fault on this
    //     model's route.
    // AUTH/SHAPE errors never trigger a cascade (a wrong key or wrong payload
    // would fail identically on every model).
    const fallbackEligible =
      err.kind === "UNAVAILABLE" ||
      err.kind === "SERVER" ||
      (err.kind === "RATE_LIMIT" && !err.isDailyQuotaExhausted);
    if (fallbackEligible && fallbackModel && fallbackModel !== primaryModel) {
      try {
        const waitMs = Math.min(
          30_000,
          err.kind === "RATE_LIMIT" && err.retryAfterMs && err.retryAfterMs > 0 ? err.retryAfterMs : 2_000,
        );
        await new Promise((r) => setTimeout(r, waitMs));
        return await embedWithModel(fallbackModel, apiKey, trimmed);
      } catch (fallbackErr) {
        throw fallbackErr instanceof EmbeddingError ? fallbackErr : err;
      }
    }
    throw err;
  }
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
