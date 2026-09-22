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

    // Batch to keep memory modest on 16 GB RAM.
    const vectors: number[][] = [];
    const BATCH = 32;
    for (let i = 0; i < documents.length; i += BATCH) {
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
    const BATCH = 32;
    for (let i = 0; i < fresh.length; i += BATCH) {
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
