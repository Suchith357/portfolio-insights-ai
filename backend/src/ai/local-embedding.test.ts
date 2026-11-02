/**
 * Local quota-free embedding fallback tests — offline, no network.
 *
 *   cd backend && npx tsx --test src/ai/local-embedding.test.ts
 *
 * Covers: determinism (same text → same vector), fixed 384-d geometry,
 * unit normalisation, discrimination (related texts closer than unrelated),
 * graceful zero vectors, and end-to-end retrieval through the FAISS store in
 * the local space (evidence retrieval after a local rebuild).
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env["AI_DATA_DIR"] = fs.mkdtempSync(path.join(os.tmpdir(), "piq-local-embed-"));
delete process.env["OPENROUTER_API_KEY"];
delete process.env["AI_EMBED_PROVIDER"];
process.env["AI_RUNTIME"] = "OPENROUTER";

import { localEmbed, localEmbedMany, LOCAL_EMBED_DIM, LOCAL_EMBED_MODEL } from "./local-embedding.js";
import { aiConfig } from "./config.js";
import { __resetEmbeddingProviderForTest, embedOne } from "./embedding.js";
import { vectorStore } from "./vector-store.js";

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += (a[i] ?? 0) * (b[i] ?? 0);
  return dot;
}

describe("local embedding fallback (hashing BoW)", () => {
  test("deterministic: identical text → identical vector, across calls", () => {
    const a = localEmbed("Reliance Industries Q2 net profit rises 12% on record retail margins");
    const b = localEmbed("Reliance Industries Q2 net profit rises 12% on record retail margins");
    assert.deepEqual(a, b);
    assert.equal(a.length, LOCAL_EMBED_DIM);
  });

  test("unit-normalised and non-zero for real text", () => {
    const v = localEmbed("NTPC reports strong quarterly earnings and announces a new solar project");
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    assert.ok(Math.abs(norm - 1) < 1e-9, `expected unit norm, got ${norm}`);
    assert.ok(v.some((x) => x !== 0));
  });

  test("empty and stopword-only inputs yield a safe zero vector (no NaN)", () => {
    for (const input of ["", "   ", "the and of to is"]) {
      const v = localEmbed(input);
      assert.equal(v.length, LOCAL_EMBED_DIM);
      assert.ok(v.every((x) => x === 0 && Number.isFinite(x)));
    }
  });

  test("discriminates: related texts score higher than unrelated ones", () => {
    const query = localEmbed("What are the key risks for Reliance Industries?");
    const related = localEmbed(
      "RELIANCE — Reliance Industries Limited. Risk: volatility 24.1%, max drawdown -31.2%. Reliance Industries net profit margins under pressure in refining.",
    );
    const unrelated = localEmbed(
      "Football world cup highlights: five goals scored in the final minute of extra time.",
    );
    const relatedScore = cosine(query, related);
    const unrelatedScore = cosine(query, unrelated);
    assert.ok(
      relatedScore > unrelatedScore,
      `related (${relatedScore.toFixed(3)}) must beat unrelated (${unrelatedScore.toFixed(3)})`,
    );
    assert.ok(relatedScore > 0.15, `related score too weak: ${relatedScore.toFixed(3)}`);
  });

  test("batch preserves order and per-item geometry", () => {
    const batch = localEmbedMany(["alpha beta gamma", "delta epsilon", ""]);
    assert.equal(batch.length, 3);
    assert.deepEqual(batch[0], localEmbed("alpha beta gamma"));
    assert.equal(batch[2]?.length, LOCAL_EMBED_DIM);
  });
});

describe("retrieval in the local space (no provider HTTP)", () => {
  before(() => {
    aiConfig.switchEmbeddingProvider("local");
    const docs = [
      {
        title: "RELIANCE — Reliance Industries Limited",
        content:
          "PortfolioIQ tracks Reliance Industries Limited (symbol RELIANCE) in the Energy sector. Reliance Industries refining margins and retail expansion are the key business drivers.",
        meta: {
          documentId: "STOCK:1",
          documentType: "STOCK_INFORMATION" as const,
          source: "PortfolioIQ stock universe",
        },
      },
      {
        title: "Cricket world cup final ends in a tie",
        content: "The cricket world cup final ended in a dramatic tie after the last ball of the innings.",
        meta: {
          documentId: "NEWS:2",
          documentType: "NEWS" as const,
          source: "Sports desk",
        },
      },
    ];
    vectorStore.replaceAll(
      docs as never,
      docs.map((d) => localEmbed(`${d.title}\n${d.content}`)),
    );
  });

  after(() => {
    __resetEmbeddingProviderForTest();
    vectorStore.clearFiles();
  });

  test("index is stamped with the local model geometry", () => {
    assert.equal(aiConfig.embeddingModel, LOCAL_EMBED_MODEL);
    assert.equal(aiConfig.embeddingProvider, "local");
    assert.equal(vectorStore.size, 2);
  });

  test("embedOne needs no HTTP and retrieves the matching document", async () => {
    // No fetch stub installed — any network attempt would throw/fail here.
    const q = await embedOne("What drives Reliance Industries profitability?");
    assert.equal(q.length, LOCAL_EMBED_DIM);
    const hits = vectorStore.search(q, 3);
    assert.ok(hits.length > 0, "expected at least one hit");
    const top = vectorStore.toEvidence(hits[0]!.rowId, hits[0]!.score);
    assert.equal(top?.documentId, "STOCK:1", "top hit must be the Reliance document");
    assert.ok((hits[0]!.score ?? 0) > 0.2, `top score too weak: ${hits[0]!.score}`);
  });

  test("geometry guard: a mismatched runtime drops the in-memory view but keeps files", () => {
    const indexPath = aiConfig.indexPath;
    const metaPath = aiConfig.metadataPath;
    assert.ok(fs.existsSync(indexPath) && fs.existsSync(metaPath), "local index files must exist");
    // Simulate an admin forcing the hosted space back while the local index is loaded.
    aiConfig.switchEmbeddingProvider("hosted");
    try {
      const compatible = vectorStore.ensureCompatibleWithRuntime();
      assert.equal(compatible, false, "mismatched geometry must be detected");
      assert.equal(vectorStore.size, 0, "in-memory view dropped");
      assert.ok(fs.existsSync(indexPath) && fs.existsSync(metaPath), "files preserved on disk");
    } finally {
      aiConfig.switchEmbeddingProvider("local");
    }
  });
});
