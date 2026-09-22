/**
 * Research retrieval (Prompt 4).
 *
 * ONE generic query is not enough for a research report. This service issues
 * multiple targeted retrieval queries (company news, events, sector, macro,
 * historical), merges the results, removes duplicates, reranks by a blend of
 * similarity and source quality, and enforces an evidence budget. It also
 * computes an EVIDENCE-QUALITY score (0..1) used by the decision engine and
 * the confidence model.
 */

import { retrieve } from "../retriever.js";
import { aiConfig } from "../config.js";
import type { RetrievedEvidence } from "../types.js";

export interface ResearchEvidence {
  merged: RetrievedEvidence[];
  /** 0..1 — coverage/diversity/recency of the retrieved evidence. */
  qualityScore: number;
  qualityReasons: string[];
  queriesRun: string[];
}

const QUERY_SETS = (symbol: string, company: string): Array<{ label: string; query: string; stockSymbol?: string }> => [
  { label: "company-news", query: `Recent news and developments affecting ${company} (${symbol})`, stockSymbol: symbol },
  { label: "company-events", query: `Important detected events involving ${symbol}`, stockSymbol: symbol },
  { label: "sector", query: `Recent sector-level developments in ${company}'s industry and policy changes affecting the sector` },
  { label: "macro", query: "Recent macroeconomic and policy events affecting Indian equity markets" },
  { label: "historical", query: `Historical events and market reactions involving ${symbol} or its sector`, stockSymbol: symbol },
  { label: "profile", query: `${company} company profile and financial information`, stockSymbol: symbol },
];

/** Per-query topK so the merged pool is meaningful but bounded. */
const PER_QUERY_K = 5;
const MAX_EVIDENCE = 14;

function sourceWeight(source: string): number {
  const s = source.toLowerCase();
  if (s.includes("quantitative engine") || s.includes("portfolioiq")) return 0.15; // authoritative internal
  if (s.includes("reuters") || s.includes("bloomberg") || s.includes("economic times") || s.includes("moneycontrol") || s.includes("mint")) return 0.1;
  return 0.05; // general web source
}

function recencyBoost(publishedAt: string | null | undefined): number {
  if (!publishedAt) return 0;
  const ageDays = (Date.now() - new Date(publishedAt).getTime()) / 86_400_000;
  if (ageDays <= 3) return 0.12;
  if (ageDays <= 14) return 0.08;
  if (ageDays <= 45) return 0.04;
  return 0;
}

export async function retrieveResearchEvidence(symbol: string, companyName: string, extraFocus?: string): Promise<ResearchEvidence> {
  const queries = QUERY_SETS(symbol, companyName);
  if (extraFocus) queries.push({ label: "focus", query: extraFocus, stockSymbol: symbol });

  const byId = new Map<string, { evidence: RetrievedEvidence; best: number; hits: number }>();
  const queriesRun: string[] = [];

  for (const q of queries) {
    queriesRun.push(q.label);
    const res = await retrieve(q.query, { topK: PER_QUERY_K, stockSymbol: q.stockSymbol, minScore: Math.max(0.2, aiConfig.minScore - 0.1) });
    for (const ev of res.evidence) {
      const prev = byId.get(ev.documentId);
      if (prev) {
        prev.hits += 1;
        prev.best = Math.max(prev.best, ev.score);
      } else {
        byId.set(ev.documentId, { evidence: ev, best: ev.score, hits: 1 });
      }
    }
  }

  // Rerank: similarity + multi-query corroboration + source quality + recency.
  const ranked = [...byId.values()]
    .map(({ evidence, best, hits }) => ({
      evidence,
      rank: best + hits * 0.08 + sourceWeight(evidence.source) + recencyBoost(evidence.publishedAt),
    }))
    .sort((a, b) => b.rank - a.rank)
    .slice(0, MAX_EVIDENCE)
    .map((r, i) => ({ ...r.evidence, score: Math.round(r.rank * 1000) / 1000, snippet: r.evidence.snippet, documentId: r.evidence.documentId, title: r.evidence.title, source: r.evidence.source, publishedAt: r.evidence.publishedAt, _slot: i }))
    .map((e) => {
      const { _slot, ...rest } = e;
      void _slot;
      return rest as RetrievedEvidence;
    });

  // Evidence-quality: coverage across query types + source diversity + recency.
  const reasons: string[] = [];
  const typeCoverage = new Set(ranked.map((e) => e.documentType)).size;
  const uniqueSources = new Set(ranked.map((e) => e.source)).size;
  const withDates = ranked.filter((e) => e.publishedAt !== null).length;
  let quality = 0;
  if (ranked.length >= 5) quality += 0.3; else { quality += ranked.length * 0.06; reasons.push(`only ${ranked.length} evidence items retrieved`); }
  quality += Math.min(0.25, typeCoverage * 0.07);
  if (typeCoverage <= 1) reasons.push("evidence comes from a single document type");
  quality += Math.min(0.2, uniqueSources * 0.05);
  if (uniqueSources <= 1) reasons.push("single-source evidence");
  quality += withDates > 0 ? 0.15 : 0;
  const fresh = ranked.filter((e) => e.publishedAt && Date.now() - new Date(e.publishedAt).getTime() < 30 * 86_400_000).length;
  quality += fresh > 0 ? Math.min(0.1, fresh * 0.03) : 0;
  if (fresh === 0) reasons.push("no evidence published within the last 30 days");

  return {
    merged: ranked,
    qualityScore: Math.round(Math.min(1, quality) * 100) / 100,
    qualityReasons: reasons,
    queriesRun,
  };
}
