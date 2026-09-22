/**
 * LLM client (PortfolioIQ AI foundation).
 *
 * Calls the local Ollama-compatible /api/chat endpoint running
 * Qwen3-4B-Instruct (q4_K_M, ~4.5 GB VRAM at 4096 ctx on the RTX 4050).
 * Failures are typed (LlmError) so the orchestrator can degrade gracefully.
 */

import { aiConfig } from "./config.js";
import { probeServer } from "./embedding.js";

export class LlmError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LlmError";
  }
}

export interface ChatOptions {
  temperature?: number;
  numCtx?: number;
  maxTokens?: number;
  timeoutMs?: number;
}

export async function chat(system: string, user: string, options: ChatOptions = {}): Promise<string> {
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
    const msg = (err as Error).name === "TimeoutError" ? `LLM timed out after ${options.timeoutMs ?? aiConfig.llmTimeoutMs} ms` : `LLM server unreachable: ${(err as Error).message}`;
    throw new LlmError(msg);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new LlmError(`LLM request failed (HTTP ${res.status}): ${text.slice(0, 200)}`);
  }
  const parsed = (await res.json()) as { message?: { content?: string } };
  const content = parsed.message?.content;
  if (typeof content !== "string" || content.trim().length === 0) {
    throw new LlmError("LLM returned an empty response.");
  }
  return content;
}

/** Cheap readiness probe with a 30 s wall — avoids hanging requests. */
export async function llmReady(): Promise<boolean> {
  const { reachable } = await probeServer();
  return reachable;
}
