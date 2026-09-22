/**
 * AI/RAG document model (PortfolioIQ AI foundation).
 *
 * A KnowledgeDocument is the unit of embedding and retrieval. It is a
 * NORMALIZED projection of structured PostgreSQL data — never a dump of raw
 * rows — with provenance metadata so every retrieved passage can be traced
 * back to its source table/row.
 */

export const DOCUMENT_TYPES = [
  "NEWS",
  "EVENT",
  "STOCK_INFORMATION",
  "FINANCIAL_INFORMATION",
  "HISTORICAL_EVENT",
] as const;

export type DocumentType = (typeof DOCUMENT_TYPES)[number];

/** Extensible metadata block carried alongside every document. */
export interface DocumentMetadata {
  documentId: string;
  documentType: DocumentType;
  source: string;
  /** Optional provenance. */
  sourceUrl?: string | null;
  stockSymbol?: string | null;
  stockId?: number | null;
  eventId?: number | null;
  sector?: string | null;
  publishedAt?: string | null;
  /** [0,1] provider/self-assessed relevance; undefined when not assessed. */
  relevance?: number | null;
  /** [0,1] mapping confidence; undefined when not assessed. */
  confidence?: number | null;
  /** Hash of the canonical content — used for cheap change detection. */
  contentHash?: string | null;
  /** ISO timestamp when this document row was (re)indexed. */
  indexedAt?: string | null;
}

export interface KnowledgeDocument {
  meta: DocumentMetadata;
  title: string;
  /** The canonical text that gets embedded. */
  content: string;
}

/** A single retrieved passage with its similarity score. */
export interface RetrievedEvidence {
  documentId: string;
  documentType: DocumentType;
  title: string;
  snippet: string;
  score: number;
  source: string;
  sourceUrl?: string | null;
  stockSymbol?: string | null;
  eventId?: number | null;
  sector?: string | null;
  publishedAt?: string | null;
  confidence?: number | null;
}

/** High-level availability of the whole AI subsystem. */
export type AiAvailability =
  | "READY"
  | "DEGRADED" // index present but LLM/embedding server unreachable
  | "UNAVAILABLE" // runtime off, missing index, or server unreachable
  | "DISABLED";

export interface AiStatus {
  availability: AiAvailability;
  runtime: string;
  llmModel: string;
  embeddingModel: string;
  quantization: string;
  documentsIndexed: number;
  indexExists: boolean;
  lastIndexedAt: string | null;
  embeddingServerReachable: boolean;
  detail: string;
}

/** Timing/provenance information attached to every query result. */
export interface QueryMeta {
  topK: number;
  minScore: number;
  retrievalMs: number;
  generationMs: number | null;
  model: string;
  documentsIndexed: number;
}

/** Result envelope for the grounded query pipeline (discriminated union). */
export type GroundedQueryResult =
  | { grounding: "GROUNDED"; evidence: RetrievedEvidence[]; analysis: StructuredAnalysis; meta: QueryMeta }
  | { grounding: "INSUFFICIENT_EVIDENCE"; unavailableReason: string; evidence: RetrievedEvidence[]; meta: QueryMeta }
  | { grounding: "UNAVAILABLE"; unavailableReason: string; evidence: RetrievedEvidence[]; meta: QueryMeta };

/** Structured LLM output — Zod-validated in output-schema.ts. */
export interface StructuredAnalysis {
  analysis: string;
  key_factors: string[];
  positive_factors: string[];
  negative_factors: string[];
  risk_assessment: string;
  uncertainty: string;
  evidence: Array<{ documentId: string; title: string; source: string; sourceUrl?: string | null }>;
  confidence: number; // 0..1, reflects how well evidence covered the question
}
