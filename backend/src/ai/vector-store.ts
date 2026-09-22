/**
 * FAISS vector store (PortfolioIQ AI foundation).
 *
 * Wraps faiss-node's IndexFlatIP (inner-product = cosine on unit vectors) plus
 * a JSON metadata sidecar that maps row ids back to KnowledgeDocuments.
 * Persistence is atomic (tmp file + rename) so a crash can never leave a
 * half-written index. PostgreSQL remains the source of truth; this store is
 * rebuilt at any time from the document builders.
 */

import fs from "node:fs";
import faiss from "faiss-node";
import { aiConfig } from "./config.js";
import type { KnowledgeDocument, DocumentMetadata } from "./types.js";

interface StoredMeta extends DocumentMetadata {
  title: string;
  content: string;
}

export class VectorStore {
  private index: faiss.IndexFlatIP | null = null;
  private metadata: StoredMeta[] = [];

  get size(): number {
    return this.metadata.length;
  }

  get exists(): boolean {
    return fs.existsSync(aiConfig.indexPath) && fs.existsSync(aiConfig.metadataPath);
  }

  get lastIndexedAt(): string | null {
    try {
      const raw = JSON.parse(fs.readFileSync(aiConfig.metadataPath, "utf-8")) as { indexedAt?: string };
      return raw.indexedAt ?? null;
    } catch {
      return null;
    }
  }

  /** Load an existing index from disk, or start empty. Never throws on corrupt files. */
  load(): VectorStore {
    if (!this.exists) return this;
    try {
      this.index = faiss.IndexFlatIP.read(aiConfig.indexPath);
      const raw = JSON.parse(fs.readFileSync(aiConfig.metadataPath, "utf-8")) as { documents: StoredMeta[] };
      this.metadata = raw.documents ?? [];
      if (this.index && this.index.ntotal() !== this.metadata.length) {
        console.warn(
          `[ai:store] index/metadata mismatch (index=${this.index.ntotal()}, metadata=${this.metadata.length}) — treating index as empty; rebuild required.`,
        );
        this.index = new faiss.IndexFlatIP(aiConfig.embeddingDim);
        this.metadata = [];
      }
    } catch (err) {
      console.error(`[ai:store] failed to load index (${(err as Error).message}) — starting empty.`);
      this.index = new faiss.IndexFlatIP(aiConfig.embeddingDim);
      this.metadata = [];
    }
    return this;
  }

  /**
   * Lazily hydrate from disk exactly once per process. Without this, a server
   * restart reported a valid persisted index as "empty" (in-memory size 0)
   * until an admin rebuilt it — a real observed bug.
   */
  ensureLoaded(): void {
    if (this.index === null && this.exists) this.load();
  }

  /** Replace the entire store with the given documents + vectors (full rebuild). */
  replaceAll(documents: KnowledgeDocument[], vectors: number[][]): void {
    if (documents.length !== vectors.length) throw new Error("document/vector count mismatch");
    if (vectors.some((v) => v.length !== aiConfig.embeddingDim)) {
      throw new Error(`embedding dimensionality must be ${aiConfig.embeddingDim}`);
    }
    const index = new faiss.IndexFlatIP(aiConfig.embeddingDim);
    if (vectors.length > 0) index.add(vectors.flat());
    this.index = index;
    this.metadata = documents.map((d) => ({ ...d.meta, title: d.title, content: d.content }));
    this.save();
  }

  /**
   * Incremental append (Prompt 2+3): add new documents + vectors to the live
   * index without a full rebuild. The FAISS index and metadata sidecar are
   * re-persisted atomically; a failure during save leaves the previous files
   * intact (tmp+rename ordering below).
   */
  append(documents: KnowledgeDocument[], vectors: number[][]): void {
    if (documents.length !== vectors.length) throw new Error("document/vector count mismatch");
    if (documents.length === 0) return;
    if (vectors.some((v) => v.length !== aiConfig.embeddingDim)) {
      throw new Error(`embedding dimensionality must be ${aiConfig.embeddingDim}`);
    }
    if (!this.index) {
      this.index = new faiss.IndexFlatIP(aiConfig.embeddingDim);
      this.metadata = [];
    }
    this.index.add(vectors.flat());
    this.metadata.push(...documents.map((d) => ({ ...d.meta, title: d.title, content: d.content })));
    this.save();
  }

  /** Cosine search over the store; returns row ids + similarity in [−1, 1]. */
  search(queryVector: number[], topK: number): Array<{ rowId: number; score: number }> {
    if (!this.index || this.metadata.length === 0 || topK <= 0) return [];
    const k = Math.min(topK, this.metadata.length);
    const { labels, distances } = this.index.search(queryVector, k);
    return labels
      .map((rowId, i) => ({ rowId: Number(rowId), score: Number(distances[i]) }))
      .filter((r) => r.rowId >= 0 && r.rowId < this.metadata.length);
  }

  /** Convert a search hit into an evidence object with a bounded snippet. */
  toEvidence(rowId: number, score: number, snippetChars = 400) {
    const m = this.metadata[rowId];
    if (!m) return null;
    return {
      documentId: m.documentId,
      documentType: m.documentType,
      title: m.title,
      snippet: m.content.slice(0, snippetChars),
      score,
      source: m.source,
      sourceUrl: m.sourceUrl ?? null,
      stockSymbol: m.stockSymbol ?? null,
      eventId: m.eventId ?? null,
      sector: m.sector ?? null,
      publishedAt: m.publishedAt ?? null,
      confidence: m.confidence ?? null,
    };
  }

  /** Full metadata rows for prompt construction. */
  documentsAt(rowIds: number[]): Array<StoredMeta | undefined> {
    return rowIds.map((id) => this.metadata[id]);
  }

  private save(): void {
    aiConfig.ensureDataDir();
    const writeAtomic = (target: string, data: string | Buffer) => {
      const tmp = `${target}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, data);
      fs.renameSync(tmp, target);
    };
    // faiss-node writes the binary itself (atomic via tmp+rename on our side).
    if (this.index) {
      const tmpIndex = `${aiConfig.indexPath}.tmp-${process.pid}`;
      this.index.write(tmpIndex);
      fs.renameSync(tmpIndex, aiConfig.indexPath);
    }
    writeAtomic(aiConfig.metadataPath, JSON.stringify({ indexedAt: new Date().toISOString(), documents: this.metadata }));
  }

  /** Remove store artifacts (admin reset). */
  clearFiles(): void {
    for (const f of [aiConfig.indexPath, aiConfig.metadataPath]) {
      try {
        fs.rmSync(f, { force: true });
      } catch {
        /* best-effort */
      }
    }
    this.index = null;
    this.metadata = [];
  }
}

/** Shared singleton — the index is small (thousands of docs) and read-heavy. */
export const vectorStore = new VectorStore();
