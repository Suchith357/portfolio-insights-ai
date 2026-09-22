/**
 * Retriever (PortfolioIQ AI foundation).
 *
 * Natural-language query → embedding → FAISS inner-product search → metadata
 * filtering → minimum-score threshold. If nothing clears the threshold the
 * caller receives an explicit INSUFFICIENT state — the system must never pass
 * unrelated documents to the LLM.
 */

import { aiConfig } from "./config.js";
import { embedOne, EmbeddingError } from "./embedding.js";
import { vectorStore } from "./vector-store.js";
import type { RetrievedEvidence, DocumentType } from "./types.js";

export interface RetrieveOptions {
  topK?: number;
  minScore?: number;
  /** Restrict retrieval to certain document types. */
  documentTypes?: DocumentType[];
  /** Only documents about this stock symbol. */
  stockSymbol?: string;
  /** Only documents linked to this intelligence event. */
  eventId?: number;
}

export interface RetrievalResult {
  evidence: RetrievedEvidence[];
  retrievalMs: number;
  /** True when the query itself could not be embedded (server down). */
  failed: boolean;
  failureReason?: string;
}

export async function retrieve(query: string, options: RetrieveOptions = {}): Promise<RetrievalResult> {
  const started = Date.now();
  const topK = Math.max(1, options.topK ?? aiConfig.topK);
  const minScore = Math.min(1, Math.max(0, options.minScore ?? aiConfig.minScore));

  let queryVector: number[];
  try {
    queryVector = await embedOne(query);
  } catch (err) {
    return {
      evidence: [],
      retrievalMs: Date.now() - started,
      failed: true,
      failureReason: err instanceof EmbeddingError ? err.message : "query embedding failed",
    };
  }

  // Over-fetch so metadata filtering can still fill topK.
  const candidates = vectorStore.search(queryVector, topK * 3);
  const filtered = candidates.filter((c) => {
    const ev = vectorStore.toEvidence(c.rowId, c.score);
    if (!ev) return false;
    if (options.documentTypes && !options.documentTypes.includes(ev.documentType)) return false;
    if (options.stockSymbol && ev.stockSymbol !== options.stockSymbol) return false;
    if (options.eventId !== undefined && ev.eventId !== options.eventId) return false;
    return true;
  });

  const aboveThreshold = filtered.filter((c) => c.score >= minScore);
  const evidence = aboveThreshold
    .slice(0, topK)
    .map((c) => vectorStore.toEvidence(c.rowId, c.score))
    .filter((e): e is NonNullable<typeof e> => e !== null);

  return { evidence, retrievalMs: Date.now() - started, failed: false };
}
