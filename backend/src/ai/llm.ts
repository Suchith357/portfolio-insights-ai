/**
 * LLM client (PortfolioIQ AI foundation).
 *
 * Two interchangeable runtimes behind one `chat()` entry point:
 *
 *  - OLLAMA (default for local dev): the local Ollama-compatible /api/chat
 *    endpoint running Qwen3-4B-Instruct (q4_K_M on the RTX 4050).
 *  - OPENROUTER (hosted; auto-selected when OPENROUTER_API_KEY is set, e.g.
 *    on Render): the official OpenRouter chat-completions endpoint —
 *    POST {OPENROUTER_BASE_URL}/chat/completions — OpenAI response shape
 *    (choices[0].message.content). The key is read EXCLUSIVELY from
 *    environment via aiConfig and is only ever sent in the Authorization
 *    header; it is never logged, echoed or returned by any code path.
 *
 * Failures are typed (LlmError with a `kind`) so callers can degrade
 * gracefully AND surface accurate user-facing reasons (missing server
 * config / provider auth problem / rate limit / general inference failure).
 */

import { aiConfig } from "./config.js";
import { probeServer } from "./embedding.js";

export type LlmErrorKind =
  | "CONFIG" // missing/misconfigured server settings (e.g. no OPENROUTER_API_KEY)
  | "AUTH" // provider rejected the credentials (401/403)
  | "RATE_LIMIT" // 429 rate limit / 402 quota exhausted
  | "UNAVAILABLE_MODEL" // model unknown, deprecated or no serving endpoint (404)
  | "TIMEOUT"
  | "SERVER" // 5xx from the provider
  | "NETWORK" // transport failure
  | "EMPTY"; // success shape but no usable content

export class LlmError extends Error {
  readonly kind: LlmErrorKind;
  readonly retryAfterMs: number | null;
  readonly isDailyQuotaExhausted: boolean;

  constructor(
    message: string,
    kind: LlmErrorKind = "SERVER",
    retryAfterMs: number | null = null,
    isDailyQuotaExhausted = false,
  ) {
    super(message);
    this.name = "LlmError";
    this.kind = kind;
    this.retryAfterMs = retryAfterMs;
    this.isDailyQuotaExhausted = isDailyQuotaExhausted;
  }
}

export interface ChatOptions {
  temperature?: number;
  /** Ollama-only context window. Ignored by OpenRouter (model-defined). */
  numCtx?: number;
  maxTokens?: number;
  timeoutMs?: number;
}

/** A single retry is bounded so requests can never loop. */
const MAX_ATTEMPTS = 2;
const RETRY_BACKOFF_MS = 2_000;
// Free-tier per-minute windows can carry a Retry-After of ~20s; honouring it
// beats failing. Still bounded so chat calls can never stall for minutes.
const RETRY_AFTER_CAP_MS = 20_000;

function openrouterHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    // Attribution per OpenRouter docs; these are URLs/labels, never secrets.
    "HTTP-Referer": "https://portfolio-insights-ai-zeta.vercel.app",
    "X-Title": "PortfolioIQ",
  };
}

/** Parse OpenRouter's error envelope into a typed, user-safe message. */
function classifyOpenRouterStatus(status: number, bodyText: string, headers?: Headers): LlmError {
  let detail = "";
  let errorMessage = "";
  let errorCode: number | undefined;

  try {
    const body = JSON.parse(bodyText) as { error?: { message?: string; code?: number } | string };
    if (typeof body.error === "string") {
      errorMessage = body.error;
    } else if (body.error && typeof body.error === "object") {
      errorCode = body.error.code ?? (Number.isFinite(Number((body.error as any).code)) ? Number((body.error as any).code) : undefined);
      errorMessage = typeof body.error.message === "string" ? body.error.message : "";
    }
    detail = errorMessage;
    // Redact anything that could echo credentials (defence in depth).
    detail = detail.replaceAll(/sk-or-[A-Za-z0-9_-]+/g, "[redacted]").slice(0, 300);
    if (errorCode === 429) detail = detail || "provider rate limit exceeded";
  } catch {
    detail = bodyText.slice(0, 200).replaceAll(/sk-or-[A-Za-z0-9_-]+/g, "[redacted]");
  }

  const combined = (detail + " " + errorMessage).toLowerCase();
  const isDailyQuotaExhausted =
    combined.includes("daily") ||
    combined.includes("day limit") ||
    combined.includes("quota exceeded") && (combined.includes("daily") || combined.includes("account")) ||
    combined.includes("credits exhausted") ||
    combined.includes("credit balance") && combined.includes("exhaust");

  const retryAfterHeader = headers?.get("Retry-After");
  const retryAfterParsed = retryAfterHeader ? Number(retryAfterHeader) : NaN;
  const retryAfterMs = Number.isFinite(retryAfterParsed) && retryAfterParsed > 0 ? retryAfterParsed * 1000 : null;

  if (status === 401 || status === 403) {
    return new LlmError(`OpenRouter rejected the server's API credentials (HTTP ${status}).`, "AUTH");
  }
  if (status === 429) {
    if (isDailyQuotaExhausted) {
      return new LlmError(
        "OpenRouter daily/quota limit exhausted (HTTP 429) — account-wide free-tier quota may be reached.",
        "RATE_LIMIT",
        retryAfterMs,
        true,
      );
    }
    return new LlmError(
      "OpenRouter rate limit exceeded (HTTP 429) — try again later.",
      "RATE_LIMIT",
      retryAfterMs,
      false,
    );
  }
  if (status === 402) {
    return new LlmError(
      "OpenRouter reports exhausted free-tier quota or an empty credit balance (HTTP 402).",
      "RATE_LIMIT",
      retryAfterMs,
      true,
    );
  }
  if (status === 404 || status === 400) {
    const kind: LlmErrorKind = status === 404 || /no endpoints|not found|not a valid model/i.test(detail) ? "UNAVAILABLE_MODEL" : "SERVER";
    return new LlmError(`OpenRouter could not serve this request (HTTP ${status})${detail ? `: ${detail}` : ""}.`, kind);
  }
  return new LlmError(`OpenRouter request failed (HTTP ${status})${detail ? `: ${detail}` : ""}.`, "SERVER");
}

async function chatWithModel(
  model: string,
  apiKey: string,
  system: string,
  user: string,
  options: ChatOptions,
): Promise<string> {
  const body = {
    model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    stream: false,
    temperature: options.temperature ?? aiConfig.temperature,
    // Output budget: same semantics as Ollama's num_predict.
    max_tokens: options.maxTokens ?? aiConfig.maxOutputTokens,
    // Exclude hidden reasoning tokens so they never eat the output budget on
    // reasoning-capable free models (supported via the `reasoning` parameter).
    reasoning: { exclude: true },
  };

  const deadline = Date.now() + (options.timeoutMs ?? aiConfig.llmTimeoutMs);
  let lastError: LlmError = new LlmError("OpenRouter request failed.", "SERVER");

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw lastError;
    let res: Response;
    try {
      res = await fetch(`${aiConfig.openrouterBaseUrl}/chat/completions`, {
        method: "POST",
        headers: openrouterHeaders(apiKey),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(remaining),
      });
    } catch (err) {
      const timedOut = (err as Error).name === "TimeoutError";
      lastError = timedOut
        ? new LlmError(`Hosted AI inference timed out after ${options.timeoutMs ?? aiConfig.llmTimeoutMs} ms.`, "TIMEOUT")
        : new LlmError(`Hosted AI provider unreachable: ${(err as Error).message}`, "NETWORK");
      continue; // single bounded retry on transport failure/timeout
    }
    if (!res.ok) {
      lastError = classifyOpenRouterStatus(res.status, await res.text().catch(() => ""), res.headers);
      // Retry IN-LOOP only for transient conditions on the SAME model. A 404 /
      // "no endpoints" (UNAVAILABLE_MODEL) is deterministic for this model —
      // retrying it only burns the Retry-After window; chatOpenRouter handles
      // it with a single fallback-model attempt instead.
      const retryable = lastError.kind === "RATE_LIMIT" || lastError.kind === "SERVER";
      // For rate limits, respect Retry-After if present
      if (retryable && attempt < MAX_ATTEMPTS) {
        const waitMs = Math.min(
          RETRY_AFTER_CAP_MS,
          lastError.retryAfterMs && lastError.retryAfterMs > 0 ? lastError.retryAfterMs : RETRY_BACKOFF_MS,
        );
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }
      throw lastError;
    }
    const parsed = (await res.json()) as {
      choices?: Array<{ message?: { content?: string | null }; finish_reason?: string | null }>;
      error?: unknown;
    };
    if (parsed.error) {
      throw new LlmError(`OpenRouter returned an error payload: ${JSON.stringify(parsed.error).slice(0, 200)}`, "SERVER");
    }
    const choice = parsed.choices?.[0];
    const content = typeof choice?.message?.content === "string" ? choice.message.content : "";
    if (content.trim().length === 0) {
      // content: null + finish_reason "length" means the response was truncated
      // by the output cap — must never be treated as a successful answer.
      throw new LlmError(
        choice?.finish_reason === "length"
          ? "The hosted model hit its output-token cap before producing an answer. Retry (a cached/fingerprinted repeat may fit)."
          : "The hosted model returned an empty response.",
        "EMPTY",
      );
    }
    return content;
  }
  throw lastError;
}

async function chatOpenRouter(system: string, user: string, options: ChatOptions): Promise<string> {
  const apiKey = aiConfig.openrouterApiKey;
  if (!apiKey) throw new LlmError("The hosted AI provider is not configured on the server (OPENROUTER_API_KEY is missing).", "CONFIG");

  const primaryModel = aiConfig.openrouterModel;
  const fallbackModel = aiConfig.llmModelFallback;

  try {
    return await chatWithModel(primaryModel, apiKey, system, user, options);
  } catch (err) {
    if (!(err instanceof LlmError)) throw err;
    // Fallback policy — ONLY for failures that are specific to the primary
    // model/its upstream provider, never for account-wide conditions:
    //   - RATE_LIMIT (transient 429/402): per-minute or per-provider limit,
    //     a different model may still have headroom. Confirmed daily/account
    //     quota exhaustion (isDailyQuotaExhausted) is account-wide → NO cascade.
    //   - UNAVAILABLE_MODEL (404 / "no endpoints"): this model was delisted or
    //     has no serving endpoint right now — model-specific, not an account cap.
    //   - SERVER (5xx from the upstream provider): transient provider fault on
    //     this model's route; a single secondary model is a bounded, sensible try.
    // AUTH/CONFIG/TIMEOUT/NETWORK/EMPTY never trigger a model cascade.
    const fallbackEligible =
      err.kind === "UNAVAILABLE_MODEL" ||
      err.kind === "SERVER" ||
      (err.kind === "RATE_LIMIT" && !err.isDailyQuotaExhausted);
    if (fallbackEligible && fallbackModel && fallbackModel !== primaryModel) {
      try {
        // Honour Retry-After before the fallback when a rate limit supplied one
        // (bounded so chat can never stall for minutes).
        const waitMs = Math.min(
          RETRY_AFTER_CAP_MS,
          err.retryAfterMs && err.retryAfterMs > 0 ? err.retryAfterMs : RETRY_BACKOFF_MS,
        );
        if (err.kind === "RATE_LIMIT") await new Promise((r) => setTimeout(r, waitMs));
        return await chatWithModel(fallbackModel, apiKey, system, user, options);
      } catch (fallbackErr) {
        // If fallback also fails, throw the original error or fallback error
        throw fallbackErr instanceof LlmError ? fallbackErr : err;
      }
    }
    throw err;
  }
}

async function chatOllama(system: string, user: string, options: ChatOptions): Promise<string> {
  const body = {
    model: aiConfig.llmModel,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    stream: false,
    options: {
      temperature: options.temperature ?? aiConfig.temperature,
      num_ctx: options.numCtx ?? aiConfig.contextLength,
      num_predict: options.maxTokens ?? aiConfig.maxOutputTokens,
    },
  };

  let res: Response;
  try {
    res = await fetch(`${aiConfig.ollamaBaseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(options.timeoutMs ?? aiConfig.llmTimeoutMs),
    });
  } catch (err) {
    throw new LlmError(
      (err as Error).name === "TimeoutError"
        ? `LLM timed out after ${options.timeoutMs ?? aiConfig.llmTimeoutMs} ms`
        : `LLM server unreachable: ${(err as Error).message}`,
      (err as Error).name === "TimeoutError" ? "TIMEOUT" : "NETWORK",
    );
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new LlmError(`LLM request failed (HTTP ${res.status}): ${text.slice(0, 200)}`);
  }
  const parsed = (await res.json()) as { message?: { content?: string } };
  const content = parsed.message?.content;
  if (typeof content !== "string" || content.trim().length === 0) {
    throw new LlmError("LLM returned an empty response.", "EMPTY");
  }
  return content;
}

/** Generate one completion through the configured runtime. */
export async function chat(system: string, user: string, options: ChatOptions = {}): Promise<string> {
  return aiConfig.runtime === "OPENROUTER" ? chatOpenRouter(system, user, options) : chatOllama(system, user, options);
}

/** Cheap readiness probe with a short wall — avoids hanging requests. */
export async function llmReady(): Promise<boolean> {
  const { reachable } = await probeServer();
  return reachable;
}
