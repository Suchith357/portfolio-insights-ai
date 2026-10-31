/**
 * OpenRouter integration tests (node:test, fully OFFLINE).
 *
 *   cd backend && npx tsx --test src/ai/openrouter.test.ts
 *
 * globalThis.fetch is replaced with a stub, so no network and no real API
 * key are involved. The tests verify:
 *   1. the OpenRouter request URL/headers/body are formed correctly,
 *   2. the API key comes only from the backend environment,
 *   3. successful responses parse to the message content,
 *   4. provider failures map to typed, user-safe error categories,
 *   5. embeddings parse {data:[{embedding}]} and discover dimensionality,
 *   6. the runtime auto-selects OPENROUTER only when the key is present.
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ---------------------------------------------------------------- env guard
process.env["AI_DATA_DIR"] = fs.mkdtempSync(path.join(os.tmpdir(), "piq-or-test-"));

import { chat, LlmError } from "./llm.js";
import { embedMany, embedOne, EmbeddingError, probeServer, requiredModelsPresent, __clearProbeCacheForTest } from "./embedding.js";
import { aiConfig, validateAiConfig } from "./config.js";

/** Structural view of the typed provider errors (avoids value-as-type refs). */
interface AiError {
  kind: string;
  message: string;
}

type FetchStub = (input: string, init?: RequestInit) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
  headers: { get(n: string): string | null };
  json(): Promise<unknown>;
}>;

const calls: Array<{ url: string; init?: RequestInit }> = [];
const realFetch = globalThis.fetch;

function installFetch(impl: FetchStub): void {
  globalThis.fetch = ((input: string, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return impl(String(input), init);
  }) as unknown as typeof fetch;
}

before(() => {
  delete process.env["AI_RUNTIME"]; // exercise auto-selection
  process.env["OPENROUTER_API_KEY"] = "sk-or-v1-testkey";
});

after(() => {
  globalThis.fetch = realFetch;
  delete process.env["OPENROUTER_API_KEY"];
  process.env["AI_RUNTIME"] = "OLLAMA"; // leave env as other suites expect it
});

describe("AI config runtime auto-selection", () => {
  test("OPENROUTER_API_KEY present → OPENROUTER; absent → OLLAMA", () => {
    assert.equal(aiConfig.runtime, "OPENROUTER");
    assert.equal(aiConfig.openrouterApiKey, "sk-or-v1-testkey");
    assert.equal(aiConfig.llmModel, aiConfig.openrouterModel);
    assert.match(aiConfig.llmModel, /:free$/);
    const saved = process.env["OPENROUTER_API_KEY"];
    delete process.env["OPENROUTER_API_KEY"];
    assert.equal(aiConfig.runtime, "OLLAMA");
    if (saved) process.env["OPENROUTER_API_KEY"] = saved;
    assert.equal(aiConfig.runtime, "OPENROUTER"); // restored, dynamic getter
  });

  test("explicit AI_RUNTIME wins over the key", () => {
    process.env["AI_RUNTIME"] = "NONE";
    try {
      assert.equal(aiConfig.runtime, "NONE");
    } finally {
      delete process.env["AI_RUNTIME"];
    }
  });

  test("missing key under explicit OPENROUTER runtime is a config problem, not a crash", () => {
    process.env["AI_RUNTIME"] = "OPENROUTER";
    try {
      const saved = process.env["OPENROUTER_API_KEY"];
      delete process.env["OPENROUTER_API_KEY"];
      const v = validateAiConfig();
      assert.equal(v.valid, false);
      assert.ok(v.problems.some((p) => p.includes("OPENROUTER_API_KEY")));
      if (saved) process.env["OPENROUTER_API_KEY"] = saved;
    } finally {
      delete process.env["AI_RUNTIME"];
    }
  });
});

describe("OpenRouter chat()", () => {
  test("request formed with env key, official URL, OpenAI body → content parsed", async () => {
    installFetch(async (url, init) => {
      assert.equal(url, "https://openrouter.ai/api/v1/chat/completions");
      const headers = new Headers(init?.headers as Record<string, string>);
      assert.equal(headers.get("authorization"), "Bearer sk-or-v1-testkey"); // ONLY from backend env
      assert.ok(headers.get("HTTP-Referer")?.startsWith("https://"));
      const body = JSON.parse(String(init?.body)) as { model: string; stream: boolean; max_tokens: number; messages: Array<{ role: string }> };
      assert.match(body.model, /:free$/);
      assert.equal(body.stream, false);
      assert.equal(body.max_tokens, 900); // option flows through
      assert.deepEqual(body.messages.map((m) => m.role), ["system", "user"]);
      return ok({ choices: [{ message: { content: "  answer text  " }, finish_reason: "stop" }] });
    });
    const out = await chat("sys", "usr", { maxTokens: 900, timeoutMs: 5_000 });
    // Untrimmed by contract — downstream parsers handle surrounding whitespace
    // (same behaviour as the Ollama path; verified intact transport).
    assert.equal(out, "  answer text  ");
  });

  test("401 → AUTH; 429 honours Retry-After with a single bounded retry", async () => {
    installFetch(async () => jsonRes(401, JSON.stringify({ error: { message: "Invalid key (sk-or-v1-evil)", code: 401 } })));
    await assert.rejects(() => chat("s", "u", { timeoutMs: 2_000 }), (e: AiError) => e.kind === "AUTH");

    let attempts = 0;
    const t0 = Date.now();
    installFetch(async () => {
      attempts += 1;
      return jsonRes(429, JSON.stringify({ error: { message: "Rate limit exceeded", code: 429 } }), { "Retry-After": "1" });
    });
    await assert.rejects(
      () => chat("s", "u", { timeoutMs: 30_000 }),
      (e: AiError) => e.kind === "RATE_LIMIT" && /rate limit|quota/i.test(e.message),
    );
    assert.equal(attempts, 2, "exactly one bounded retry on 429");
    assert.ok(Date.now() - t0 >= 900, "Retry-After was honoured");
  });

  test("404/no-endpoints → UNAVAILABLE_MODEL; 5xx → SERVER", async () => {
    installFetch(async () => jsonRes(404, JSON.stringify({ error: { message: "no endpoints for this model", code: 404 } })));
    await assert.rejects(() => chat("s", "u", { timeoutMs: 2_000 }), (e: AiError) => e.kind === "UNAVAILABLE_MODEL");
    installFetch(async () => jsonRes(502, "bad gateway"));
    await assert.rejects(() => chat("s", "u", { timeoutMs: 2_000 }), (e: AiError) => e.kind === "SERVER");
  });

  test("empty content / truncation / error envelope are never success", async () => {
    installFetch(async () => ok({ choices: [{ message: { content: null }, finish_reason: "length" }] }));
    await assert.rejects(() => chat("s", "u", { timeoutMs: 2_000 }), (e: AiError) => e.kind === "EMPTY" && /output-token cap/.test(e.message));
    installFetch(async () => ok({ choices: [{ message: { content: "" }, finish_reason: "stop" }] }));
    await assert.rejects(() => chat("s", "u", { timeoutMs: 2_000 }), LlmError);
    installFetch(async () => ok({ error: { message: "boom", code: 500 } }));
    await assert.rejects(() => chat("s", "u", { timeoutMs: 2_000 }), LlmError);
  });

  test("transport failure retries once then surfaces as NETWORK", async () => {
    calls.length = 0; // count only this test's calls
    installFetch(async () => {
      throw new Error("ECONNREFUSED");
    });
    await assert.rejects(() => chat("s", "u", { timeoutMs: 3_000 }), (e: AiError) => e.kind === "NETWORK");
    assert.equal(calls.length, 2);
  });

  test("Gemma returns 429 (transient) and falls back to secondary model successfully", async () => {
    const savedFallback = process.env["OPENROUTER_LLM_MODEL_FALLBACK"];
    process.env["OPENROUTER_LLM_MODEL_FALLBACK"] = "google/gemma-4-26b-a4b-it:free";
    // Reload config behavior by accessing fresh values
    (aiConfig as any).openrouterModelFallback = "google/gemma-4-26b-a4b-it:free";
    try {
      calls.length = 0;
      installFetch(async (url, init) => {
        const body = JSON.parse(String(init?.body)) as { model: string };
        if (body.model === aiConfig.openrouterModel) {
          return jsonRes(429, JSON.stringify({ error: { message: "Rate limit exceeded", code: 429 } }), { "Retry-After": "1" });
        }
        if (body.model === "google/gemma-4-26b-a4b-it:free") {
          return ok({ choices: [{ message: { content: "fallback answer" }, finish_reason: "stop" }] });
        }
        return jsonRes(500, "{}");
      });
      const out = await chat("s", "u", { timeoutMs: 10_000 });
      assert.equal(out, "fallback answer");
      assert.equal(calls.length >= 2, true, "should attempt primary and fallback");
    } finally {
      if (savedFallback) process.env["OPENROUTER_LLM_MODEL_FALLBACK"] = savedFallback;
      else delete process.env["OPENROUTER_LLM_MODEL_FALLBACK"];
      (aiConfig as any).openrouterModelFallback = savedFallback && savedFallback.trim() ? savedFallback.trim() : null;
    }
  });

  test("daily quota exhaustion (429 with daily/quota message) does NOT fallback", async () => {
    const savedFallback = process.env["OPENROUTER_LLM_MODEL_FALLBACK"];
    process.env["OPENROUTER_LLM_MODEL_FALLBACK"] = "google/gemma-4-26b-a4b-it:free";
    (aiConfig as any).openrouterModelFallback = "google/gemma-4-26b-a4b-it:free";
    try {
      calls.length = 0;
      installFetch(async () => {
        return jsonRes(429, JSON.stringify({ error: { message: "Daily quota exceeded for this account", code: 429 } }));
      });
      await assert.rejects(
        () => chat("s", "u", { timeoutMs: 5_000 }),
        (e: AiError) => e.kind === "RATE_LIMIT",
      );
      assert.equal(calls.length, 2, "only primary retried, no fallback on daily quota exhaustion");
    } finally {
      if (savedFallback) process.env["OPENROUTER_LLM_MODEL_FALLBACK"] = savedFallback;
      else delete process.env["OPENROUTER_LLM_MODEL_FALLBACK"];
      (aiConfig as any).openrouterModelFallback = savedFallback && savedFallback.trim() ? savedFallback.trim() : null;
    }
  });

  test("primary model delisted (404) → single fallback attempt, not an account-wide stop", async () => {
    const savedFallback = process.env["OPENROUTER_LLM_MODEL_FALLBACK"];
    process.env["OPENROUTER_LLM_MODEL_FALLBACK"] = "google/gemma-4-26b-a4b-it:free";
    (aiConfig as any).openrouterModelFallback = "google/gemma-4-26b-a4b-it:free";
    try {
      calls.length = 0;
      installFetch(async (url, init) => {
        const body = JSON.parse(String(init?.body)) as { model: string };
        if (body.model === aiConfig.openrouterModel) {
          return jsonRes(404, JSON.stringify({ error: { message: "Model not found", code: 404 } }));
        }
        return ok({ choices: [{ message: { content: "fallback after 404" }, finish_reason: "stop" }] });
      });
      const out = await chat("s", "u", { timeoutMs: 10_000 });
      assert.equal(out, "fallback after 404");
      assert.equal(calls.length, 2, "one primary 404 + one fallback success — no retry storm");
    } finally {
      if (savedFallback) process.env["OPENROUTER_LLM_MODEL_FALLBACK"] = savedFallback;
      else delete process.env["OPENROUTER_LLM_MODEL_FALLBACK"];
      (aiConfig as any).openrouterModelFallback = savedFallback && savedFallback.trim() ? savedFallback.trim() : null;
    }
  });

  test("auth failure (401) never cascades to the fallback model", async () => {
    const savedFallback = process.env["OPENROUTER_LLM_MODEL_FALLBACK"];
    process.env["OPENROUTER_LLM_MODEL_FALLBACK"] = "google/gemma-4-26b-a4b-it:free";
    (aiConfig as any).openrouterModelFallback = "google/gemma-4-26b-a4b-it:free";
    try {
      calls.length = 0;
      installFetch(async () => jsonRes(401, JSON.stringify({ error: { message: "Invalid key", code: 401 } })));
      await assert.rejects(() => chat("s", "u", { timeoutMs: 5_000 }), (e: AiError) => e.kind === "AUTH");
      assert.equal(calls.length, 1, "no fallback attempt with a bad key");
    } finally {
      if (savedFallback) process.env["OPENROUTER_LLM_MODEL_FALLBACK"] = savedFallback;
      else delete process.env["OPENROUTER_LLM_MODEL_FALLBACK"];
      (aiConfig as any).openrouterModelFallback = savedFallback && savedFallback.trim() ? savedFallback.trim() : null;
    }
  });

  test("both models rate-limited → surfaces final error", async () => {
    const savedFallback = process.env["OPENROUTER_LLM_MODEL_FALLBACK"];
    process.env["OPENROUTER_LLM_MODEL_FALLBACK"] = "google/gemma-4-26b-a4b-it:free";
    (aiConfig as any).openrouterModelFallback = "google/gemma-4-26b-a4b-it:free";
    try {
      calls.length = 0;
      installFetch(async (url, init) => {
        const body = JSON.parse(String(init?.body)) as { model: string };
        // Both return transient rate limits
        return jsonRes(429, JSON.stringify({ error: { message: "Rate limit exceeded", code: 429 } }), { "Retry-After": "1" });
      });
      await assert.rejects(
        () => chat("s", "u", { timeoutMs: 10_000 }),
        (e: AiError) => e.kind === "RATE_LIMIT",
      );
      assert.ok(calls.length >= 4, "retries on primary and then tries fallback with retries");
    } finally {
      if (savedFallback) process.env["OPENROUTER_LLM_MODEL_FALLBACK"] = savedFallback;
      else delete process.env["OPENROUTER_LLM_MODEL_FALLBACK"];
      (aiConfig as any).openrouterModelFallback = savedFallback && savedFallback.trim() ? savedFallback.trim() : null;
    }
  });
});

describe("OpenRouter embeddings", () => {
  test("embedMany posts {model,input} to /embeddings and discovers dimensionality", async () => {
    let firstCall = true;
    installFetch(async (url, init) => {
      assert.equal(url, "https://openrouter.ai/api/v1/embeddings");
      const body = JSON.parse(String(init?.body)) as { model: string; input: string[] };
      assert.equal(body.model, aiConfig.openrouterEmbeddingModel);
      // The batch-input contract is verified on the FIRST call of this test;
      // later calls in the same test use the same stub with other inputs.
      if (firstCall) {
        firstCall = false;
        assert.deepEqual(body.input, ["alpha", "beta"]);
      }
      // Payload shape must always match the input count.
      return ok({ data: body.input.map((_, i) => ({ index: i, embedding: [i, 0, 4] })) });
    });
    const out = await embedMany(["alpha", "beta"]);
    assert.equal(out.length, 2);
    assert.ok(out[0] && out[1]);
    // Stub vectors [0,0,4] and [1,0,4] normalise to unit length.
    assert.deepEqual(out[0].map((v) => Math.round(v * 10)), [0, 0, 10]);
    assert.deepEqual(out[1].map((v) => Math.round(v * 10)), [2, 0, 10]);
    assert.equal(aiConfig.embeddingDim, 3, "dimension discovered from the first response");
    const unit = await embedOne("q");
    assert.equal(Math.hypot(...unit), 1, "unit-normalised (cosine-ready)");
  });

  test("embeddings auth/quota/model/shape failures map to typed errors", async () => {
    installFetch(async () => jsonRes(401, "{}"));
    await assert.rejects(() => embedMany(["x"]), (e: AiError) => e.kind === "AUTH");
    calls.length = 0;
    installFetch(async () => jsonRes(429, JSON.stringify({ error: { message: "Rate limit exceeded" } }), { "Retry-After": "1" }));
    await assert.rejects(() => embedMany(["x"]), (e: AiError) => e.kind === "RATE_LIMIT");
    installFetch(async () => jsonRes(404, "{}"));
    await assert.rejects(() => embedMany(["x"]), (e: AiError) => e.kind === "UNAVAILABLE");
    installFetch(async () => ok({ data: [{}] }));
    await assert.rejects(() => embedMany(["x"]), (e: AiError) => e.kind === "SHAPE");
  });

  test("embedding 429 respects Retry-After and stops on daily/quota exhaustion", async () => {
    calls.length = 0;
    installFetch(async () => jsonRes(429, JSON.stringify({ error: { message: "Daily quota exceeded for this account" } }), { "Retry-After": "5" }));
    await assert.rejects(
      () => embedMany(["x"]),
      (e: any) => e.kind === "RATE_LIMIT" && e.isDailyQuotaExhausted === true,
    );
    assert.equal(calls.length, 1, "should not retry on daily/quota exhaustion");
  });

  test("embedding falls back to secondary model on transient 429 if configured", async () => {
    const saved = (aiConfig as any).openrouterEmbeddingModelFallback;
    (aiConfig as any).openrouterEmbeddingModelFallback = "text-embedding-3-small";
    try {
      calls.length = 0;
      installFetch(async (url, init) => {
        const body = JSON.parse(String(init?.body)) as { model: string };
        if (body.model === aiConfig.openrouterEmbeddingModel) {
          return jsonRes(429, JSON.stringify({ error: { message: "Rate limit exceeded" } }), { "Retry-After": "1" });
        }
        if (body.model === "text-embedding-3-small") {
          return ok({ data: [{ index: 0, embedding: [0.1, 0.2, 0.3] }] });
        }
        return jsonRes(500, "{}");
      });
      const out = await embedMany(["x"]);
      assert.equal(out.length, 1);
      assert.equal(aiConfig.embeddingDim, 3, "dims stamped from the response for the geometry check");
    } finally {
      (aiConfig as any).openrouterEmbeddingModelFallback = saved;
    }
  });

  test("embedding model delisted (404) → single fallback attempt; no cascade when unconfigured", async () => {
    const saved = (aiConfig as any).openrouterEmbeddingModelFallback;
    try {
      // 1) With a secondary configured: one primary 404, one fallback success.
      (aiConfig as any).openrouterEmbeddingModelFallback = "backup-embed-model:free";
      calls.length = 0;
      installFetch(async (url, init) => {
        const body = JSON.parse(String(init?.body)) as { model: string };
        if (body.model === aiConfig.openrouterEmbeddingModel) {
          return jsonRes(404, JSON.stringify({ error: { message: "Model not found", code: 404 } }));
        }
        return ok({ data: [{ index: 0, embedding: [0.3, 0.4] }] });
      });
      const out = await embedMany(["x"]);
      assert.equal(out.length, 1);
      assert.equal(calls.length, 2, "primary 404 + fallback only — no retry storm");

      // 2) Without a secondary: the typed UNAVAILABLE error surfaces immediately.
      (aiConfig as any).openrouterEmbeddingModelFallback = null;
      calls.length = 0;
      installFetch(async () => jsonRes(404, JSON.stringify({ error: { message: "Model not found", code: 404 } })));
      await assert.rejects(
        () => embedMany(["x"]),
        (e: AiError) => e.kind === "UNAVAILABLE" && /OPENROUTER_EMBEDDING_MODEL/.test(e.message),
      );
      assert.equal(calls.length, 1);
    } finally {
      (aiConfig as any).openrouterEmbeddingModelFallback = saved;
    }
  });
});

describe("OpenRouter readiness probe", () => {
  test("valid key → reachable; bad key → unreachable (cache reset honoured)", async () => {
    installFetch(async (url) => {
      assert.match(String(url), /\/key$/);
      return ok({ usage: 0 });
    });
    const probe = await probeServer();
    assert.equal(probe.reachable, true);
    assert.ok(probe.models.length >= 2);

    __clearProbeCacheForTest();
    installFetch(async () => jsonRes(401, "{}"));
    const bad = await requiredModelsPresent();
    assert.equal(bad.ok, false);
  });
});

// --------------------------------------------------------------------- utils
function ok(body: unknown, headers: Record<string, string> = {}) {
  return jsonRes(200, JSON.stringify(body), headers);
}

function jsonRes(status: number, bodyText: string, headers: Record<string, string> = {}): {
  ok: boolean;
  status: number;
  text: () => Promise<string>;
  headers: { get(n: string): string | null };
  json: () => Promise<unknown>;
} {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => bodyText,
    headers: { get: (n: string) => headers[n] ?? null },
    json: async () => JSON.parse(bodyText),
  };
}
