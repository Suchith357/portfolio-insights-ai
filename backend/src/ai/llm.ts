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

  constructor(message: string, kind: LlmErrorKind = "SERVER", retryAfterMs: number | null = null) {
    super(message);
    this.name = "LlmError";
    this.kind = kind;
    this.retryAfterMs = retryAfterMs;
  }
}

export interface ChatOptions {
  temperature?: number;
  /** Ollama-only context window. Ignored by OpenRouter (model-defined). */
  numCtx?: number;
  maxTokens?: number;
  timeoutMs?: number;
}

/** A single 429/5xx/transport retry is bounded so requests can never loop. */
const MAX_ATTEMPTS = 2;
const RETRY_BACKOFF_MS = 2_000;
const RETRY_AFTER_CAP_MS = 8_000;

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
function classifyOpenRouterStatus(status: number, bodyText: string): LlmError {
  let detail = "";
  try {
    const body = JSON.parse(bodyText) as { error?: { message?: string; code?: number } };
    const code = body.error?.code ?? (Number.isFinite(Number(body.error)) ? Number(body.error) : undefined);
    detail = typeof body.error?.message === "string" ? body.error.message : "";
    // Redact anything that could echo credentials (defence in depth).
    detail = detail.replaceAll(/sk-or-[A-Za-z0-9_-]+/g, "[redacted]").slice(0, 200);
    if (code === 429) detail = detail || "provider rate limit exceeded";
  } catch {
    detail = bodyText.slice(0, 200).replaceAll(/sk-or-[A-Za-z0-9_-]+/g, "[redacted]");
  }
  if (status === 401 || status === 403) {
    return new LlmError(`OpenRouter rejected the server's API credentials (HTTP ${status}).`, "AUTH");
  }
  if (status === 429) {
    return new LlmError("OpenRouter rate limit or free-tier daily quota exceeded (HTTP 429) — retry later.", "RATE_LIMIT");
  }
  if (status === 402) {
    return new LlmError("OpenRouter reports exhausted free-tier quota or an empty credit balance (HTTP 402).", "RATE_LIMIT");
  }
  if (status === 404 || status === 400) {
    const kind: LlmErrorKind = status === 404 || /no endpoints|not found|not a valid model/i.test(detail) ? "UNAVAILABLE_MODEL" : "SERVER";
    return new LlmError(`OpenRouter could not serve this request (HTTP ${status})${detail ? `: ${detail}` : ""}.`, kind);
  }
  return new LlmError(`OpenRouter request failed (HTTP ${status})${detail ? `: ${detail}` : ""}.`, "SERVER");
}

async function chatOpenRouter(system: string, user: string, options: ChatOptions): Promise<string> {
  const apiKey = aiConfig.openrouterApiKey;
  if (!apiKey) throw new LlmError("The hosted AI provider is not configured on the server (OPENROUTER_API_KEY is missing).", "CONFIG");

  const body = {
    model: aiConfig.openrouterModel,
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
      lastError = classifyOpenRouterStatus(res.status, await res.text().catch(() => ""));
      const retryable =
        lastError.kind === "RATE_LIMIT" || lastError.kind === "SERVER" || lastError.kind === "UNAVAILABLE_MODEL";
      if (retryable && attempt < MAX_ATTEMPTS) {
        const parsed = Number(res.headers.get("Retry-After"));
        const waitMs = Math.min(RETRY_AFTER_CAP_MS, Number.isFinite(parsed) && parsed > 0 ? parsed * 1000 : RETRY_BACKOFF_MS);
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
