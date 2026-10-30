/**
 * Indexer (PortfolioIQ AI foundation).
 *
 * Rebuilds the FAISS store from PostgreSQL:
 *   documents (builders) → embeddings (Qwen3-Embedding-0.6B) → atomic replace
 *
 * Properties:
 *  - bounded: takes `take` limits so one laptop never embeds the whole DB
 *  - single-flight: concurrent rebuilds collapse into the running one
 *  - failure-safe: any error leaves the previous index untouched on disk
 */

import { prisma } from "../utils/prisma.js";
import { aiConfig } from "./config.js";
import { buildDocuments } from "./document-builders.js";
import { embedMany, EmbeddingError } from "./embedding.js";
import { vectorStore } from "./vector-store.js";
import type { KnowledgeDocument } from "./types.js";

export interface IndexResult {
  ok: boolean;
  documentsIndexed: number;
  documentsConsidered: number;
  skipped: number;
  durationMs: number;
  error?: string;
}

let inFlight: Promise<IndexResult> | null = null;

const DEFAULT_LIMITS = { news: 400, events: 150, snapshots: 120 };

/**
 * Embedding batch size. 64 keeps request COUNT low (a 670-doc rebuild = 11
 * batch requests) so a cold hosted (ephemeral-disk) rebuild fits inside the
 * free-tier per-minute cap of the default OpenRouter runtime.
 */
const BATCH = 64;

/**
 * Spacing between embedding batches for the hosted runtime. The default free
 * cap is 20 requests/min → 60s/20 = 3s minimum; 3500ms leaves head-room when
 * the retrieval queries fire right after a rebuild. Local OLLAMA is untouched
 * (no external cap). Overridable via OPENROUTER_EMBED_SPACING_MS.
 */
function batchSpacingMs(): number {
  if (aiConfig.runtime !== "OPENROUTER") return 0;
  const raw = Number(process.env["OPENROUTER_EMBED_SPACING_MS"]);
  return Number.isFinite(raw) && raw >= 0 ? Math.min(30_000, raw) : 3_500;
}

export async function rebuildIndex(limits = DEFAULT_LIMITS): Promise<IndexResult> {
  if (inFlight) return inFlight;
  inFlight = doRebuild(limits).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

export function isIndexing(): boolean {
  return inFlight !== null;
}

async function doRebuild(limits: typeof DEFAULT_LIMITS): Promise<IndexResult> {
  const started = Date.now();
  try {
    const documents = await buildDocuments(prisma, limits);
    const considered = documents.length;
    if (documents.length === 0) {
      // Nothing to index (e.g. fresh DB): write an empty-but-valid store.
      vectorStore.replaceAll([], []);
      return { ok: true, documentsIndexed: 0, documentsConsidered: 0, skipped: 0, durationMs: Date.now() - started };
    }

    // Embed in batches; spacing honours hosted free-tier per-minute caps.
    const vectors: number[][] = [];
    const spacing = batchSpacingMs();
    for (let i = 0; i < documents.length; i += BATCH) {
      if (i > 0 && spacing > 0) await new Promise((r) => setTimeout(r, spacing));
      const batch = documents.slice(i, i + BATCH).map((d) => `${d.title}\n${d.content}`);
      const batchVecs = await embedMany(batch);
      vectors.push(...batchVecs);
    }

    vectorStore.replaceAll(documents, vectors);
    console.log(`[ai:indexer] indexed ${documents.length}/${considered} documents in ${Date.now() - started} ms`);
    return { ok: true, documentsIndexed: documents.length, documentsConsidered: considered, skipped: considered - documents.length, durationMs: Date.now() - started };
  } catch (err) {
    const message =
      err instanceof EmbeddingError
        ? `embedding server unavailable — index unchanged: ${err.message}`
        : `index rebuild failed — index unchanged: ${(err as Error).message}`;
    console.error(`[ai:indexer] ${message}`);
    return { ok: false, documentsIndexed: 0, documentsConsidered: 0, skipped: 0, durationMs: Date.now() - started, error: message };
  }
}

export function indexStatus() {
  vectorStore.ensureLoaded(); // restart resilience: reflect the persisted index, not an unhydrated process
  return {
    indexExists: vectorStore.exists,
    documentsIndexed: vectorStore.size,
    lastIndexedAt: vectorStore.lastIndexedAt,
    indexingNow: isIndexing(),
    indexPath: aiConfig.indexPath.replace(/\\/g, "/"),
  };
}

// ---------------------------------------------------------------------
// Lazy self-healing for hosted runtimes. On Render (or any fresh process)
// the FAISS artifacts live on an ephemeral disk, so the index starts empty
// after every deploy. Instead of requiring an admin curl before Deep
// Analysis can ever work, the first AI query that needs the index triggers
// a bounded, single-flight rebuild from PostgreSQL here. A recent failure
// is remembered briefly so a burst of queries cannot hammer the provider.
// ---------------------------------------------------------------------

let lastEnsureFailure: { at: number; error: string } | null = null;
const FAILURE_COOLDOWN_MS = 2 * 60_000;

export async function ensureIndexReady(): Promise<{ ok: boolean; rebuilt: boolean; documentsIndexed: number; reason?: string }> {
  vectorStore.ensureLoaded(); // restart resilience first
  if (vectorStore.exists && vectorStore.size > 0) return { ok: true, rebuilt: false, documentsIndexed: vectorStore.size };
  if (lastEnsureFailure && Date.now() - lastEnsureFailure.at < FAILURE_COOLDOWN_MS) {
    return { ok: false, rebuilt: false, documentsIndexed: 0, reason: lastEnsureFailure.error };
  }
  const result = await rebuildIndex();
  if (result.ok && result.documentsIndexed > 0) {
    lastEnsureFailure = null;
    return { ok: true, rebuilt: true, documentsIndexed: result.documentsIndexed };
  }
  const reason = result.error ?? "index rebuild produced no documents";
  lastEnsureFailure = { at: Date.now(), error: reason };
  return { ok: false, rebuilt: true, documentsIndexed: 0, reason };
}

// ---------------------------------------------------------------------
// Incremental indexing (Prompt 2+3): append NEW important-event documents
// without a full rebuild. Single-flight shared with rebuild; a failed
// append leaves the previous valid index untouched (artifacts are only
// replaced after a successful embed+add).
// ---------------------------------------------------------------------

export interface AppendResult {
  ok: boolean;
  appended: number;
  skippedExisting: number;
  error?: string;
}

let appendInFlight: Promise<AppendResult> | null = null;

export function isAppending(): boolean {
  return appendInFlight !== null;
}

/**
 * Append documents whose documentId is not already present. Bounded by the
 * caller (news pipeline passes only NEW important events).
 */
export async function appendDocuments(documents: KnowledgeDocument[]): Promise<AppendResult> {
  if (documents.length === 0) return { ok: true, appended: 0, skippedExisting: 0 };
  if (appendInFlight) return appendInFlight;
  appendInFlight = doAppend(documents).finally(() => {
    appendInFlight = null;
  });
  return appendInFlight;
}

async function doAppend(documents: KnowledgeDocument[]): Promise<AppendResult> {
  try {
    // Current store must be loaded before mutating (cheap; single process).
    if (vectorStore.size === 0 && vectorStore.exists) vectorStore.load();
    const existing = new Set<string>();
    for (let i = 0; i < vectorStore.size; i++) {
      const ev = vectorStore.toEvidence(i, 0);
      if (ev) existing.add(ev.documentId);
    }
    const fresh = documents.filter((d) => !existing.has(d.meta.documentId));
    const skippedExisting = documents.length - fresh.length;
    if (fresh.length === 0) return { ok: true, appended: 0, skippedExisting };

    const vectors: number[][] = [];
    const spacing = batchSpacingMs();
    for (let i = 0; i < fresh.length; i += BATCH) {
      if (i > 0 && spacing > 0) await new Promise((r) => setTimeout(r, spacing));
      const batch = fresh.slice(i, i + BATCH).map((d) => `${d.title}\n${d.content}`);
      vectors.push(...(await embedMany(batch)));
    }
    vectorStore.append(fresh, vectors);
    console.log(`[ai:indexer] appended ${fresh.length} documents (skipped ${skippedExisting} existing)`);
    return { ok: true, appended: fresh.length, skippedExisting };
  } catch (err) {
    const message = `incremental index update failed — index unchanged: ${(err as Error).message}`;
    console.error(`[ai:indexer] ${message}`);
    return { ok: false, appended: 0, skippedExisting: 0, error: message };
  }
}
