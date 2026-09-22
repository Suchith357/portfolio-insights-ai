/**
 * Document builders (PortfolioIQ AI foundation).
 *
 * Convert structured PostgreSQL rows into embeddable KnowledgeDocuments.
 * Builders NEVER dump raw rows: each document is a short, self-contained,
 * human-readable projection with provenance. Content is deterministic so a
 * content hash detects real changes, not formatting noise.
 *
 * Types implemented for this foundation phase:
 *   NEWS               ← intelligence_news_articles
 *   EVENT              ← intelligence_news_events
 *   STOCK_INFORMATION  ← stocks (the 38-stock universe)
 *   FINANCIAL_INFORMATION ← portfolio_risk_snapshots (calculated metrics)
 *   HISTORICAL_EVENT   ← intelligence_news_events (permanent, resolved)
 */

import { createHash } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import type { KnowledgeDocument, DocumentMetadata, DocumentType } from "./types.js";

export function contentHashOf(title: string, content: string): string {
  return createHash("sha256").update(`${title}\n${content}`).digest("hex").slice(0, 32);
}

function meta(partial: Omit<DocumentMetadata, "contentHash">, title: string, content: string): DocumentMetadata {
  return { ...partial, contentHash: contentHashOf(title, content) };
}

function fmtDate(d: Date | string | null | undefined): string | null {
  if (!d) return null;
  const date = typeof d === "string" ? new Date(d) : d;
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------- NEWS
export function newsArticleDocument(a: {
  article_id: number;
  provider: string;
  title: string;
  description?: string | null;
  url?: string | null;
  source_name?: string | null;
  published_at: Date;
  language?: string | null;
}): KnowledgeDocument | null {
  const title = (a.title ?? "").trim();
  if (!title) return null;
  const snippet = (a.description ?? "").trim().slice(0, 900);
  const content = [
    `News article from ${a.source_name ?? a.provider} (published ${fmtDate(a.published_at) ?? "unknown date"}).`,
    snippet || title,
  ].join(" ");
  return {
    meta: meta(
      {
        documentId: `NEWS:${a.provider}:${a.article_id}`,
        documentType: "NEWS",
        source: a.source_name ?? a.provider,
        sourceUrl: a.url ?? null,
        publishedAt: a.published_at.toISOString(),
        indexedAt: null,
      },
      title,
      content,
    ),
    title,
    content,
  };
}

// ---------------------------------------------------------------- EVENT
export function eventDocument(e: {
  event_id: number;
  category: string;
  title: string;
  summary?: string | null;
  severity?: number | null;
  relevance?: unknown; // Prisma Decimal | number | null
  confidence?: unknown; // Prisma Decimal | number | null
  detected_at: Date;
  status?: string | null;
}): KnowledgeDocument | null {
  const title = (e.title ?? "").trim();
  if (!title) return null;
  const conf = e.confidence == null ? null : Number(e.confidence);
  const rel = e.relevance == null ? null : Number(e.relevance);
  const parts = [
    `Detected intelligence event (category ${e.category}, severity level ${e.severity ?? "unrated"}, status ${e.status ?? "NEW"}).`,
    (e.summary ?? "").trim().slice(0, 900) || title,
  ];
  if (conf != null || rel != null) {
    const bits: string[] = [];
    if (conf != null) bits.push(`mapping confidence ${(conf * 100).toFixed(0)}%`);
    if (rel != null) bits.push(`relevance ${(rel * 100).toFixed(0)}%`);
    parts.push(`Evidence scores: ${bits.join(", ")}. Direction, if assessed, is recorded on the event's portfolio-impact records in the structured database.`);
  }
  const content = parts.join(" ");
  return {
    meta: meta(
      {
        documentId: `EVENT:${e.event_id}`,
        documentType: "EVENT",
        source: "PortfolioIQ intelligence pipeline",
        eventId: e.event_id,
        publishedAt: e.detected_at.toISOString(),
        confidence: conf,
        indexedAt: null,
      },
      title,
      content,
    ),
    title,
    content,
  };
}

// ---------------------------------------------------- STOCK_INFORMATION
export function stockDocument(s: {
  stock_id: number;
  symbol: string;
  company_name: string;
  sector?: string | null;
  exchange?: string | null;
  description?: string | null;
}): KnowledgeDocument {
  const title = `${s.symbol} — ${s.company_name}`;
  const blurb = (s.description ?? "").trim().slice(0, 500);
  const content = `PortfolioIQ tracks ${s.company_name} (symbol ${s.symbol}) in the ${s.sector ?? "uncategorised"} sector${s.exchange ? `, listed on ${s.exchange}` : ""}. It is part of the platform's covered Indian equity universe.${blurb ? ` Company description on file: ${blurb}` : ""} Quantitative metrics for this stock (price history, volatility, returns) live in the structured database and are computed by the analytics engine, not by the AI layer.`;
  return {
    meta: meta(
      {
        documentId: `STOCK:${s.stock_id}`,
        documentType: "STOCK_INFORMATION",
        source: "PortfolioIQ stock universe",
        stockSymbol: s.symbol,
        stockId: s.stock_id,
        sector: s.sector ?? null,
        indexedAt: null,
      },
      title,
      content,
    ),
    title,
    content,
  };
}

// ---------------------------------------------- FINANCIAL_INFORMATION
export function riskSnapshotDocument(r: {
  snapshot_id: number;
  portfolio_id: number;
  snapshot_date: Date | string;
  volatility?: unknown;
  sharpe?: unknown;
  max_drawdown?: unknown;
  beta?: unknown;
  var_95?: unknown;
  calculation_version?: string;
}): KnowledgeDocument | null {
  const d = fmtDate(r.snapshot_date);
  if (!d) return null;
  // Column semantics (verified against live rows): volatility, max_drawdown
  // and var_95 are stored as PERCENTAGES (14.26 == 14.26%), so they are
  // rendered as-is — multiplying here would corrupt the evidence the LLM
  // quotes (this was a real observed bug: "volatility 1425.8%").
  const n = (v: unknown): string | null => (v == null ? null : Number(v).toFixed(4));
  const bits: string[] = [];
  const vol = n(r.volatility);
  if (vol) bits.push(`annualised volatility ${Number(vol).toFixed(1)}%`);
  const sharpe = n(r.sharpe);
  if (sharpe) bits.push(`Sharpe ratio ${sharpe}`);
  const dd = n(r.max_drawdown);
  if (dd) bits.push(`max drawdown ${Number(dd).toFixed(1)}%`);
  const beta = n(r.beta);
  if (beta) bits.push(`beta ${beta} vs NIFTY 50`);
  const var95 = n(r.var_95);
  if (var95) bits.push(`historical 95% one-day VaR ${Number(var95).toFixed(2)}%`);
  if (bits.length === 0) return null; // never embed an empty metrics doc
  const title = `Portfolio ${r.portfolio_id} risk snapshot (${d})`;
  const content = `On ${d}, the analytics engine measured portfolio ${r.portfolio_id}: ${bits.join(", ")}. These values were calculated by PortfolioIQ's quantitative engine (version ${r.calculation_version ?? "unknown"}) from stored market data; they describe historical behaviour and are not forecasts.`;
  return {
    meta: meta(
      {
        documentId: `FIN:${r.snapshot_id}`,
        documentType: "FINANCIAL_INFORMATION",
        source: "PortfolioIQ quantitative engine",
        publishedAt: new Date(r.snapshot_date as string).toISOString(),
        confidence: 1,
        indexedAt: null,
      },
      title,
      content,
    ),
    title,
    content,
  };
}

// ---------------------------------------------- STOCK_FINANCIALS (Req 7)
/**
 * FY financial statements document — one per stock with a cached provider
 * document. Deterministic projection of the stored JSONB; the LLM quotes
 * these facts verbatim in deep-analysis narratives. Returns null when the
 * document is empty/malformed (never embeds an empty metrics doc).
 */
interface StockFinancialsDoc {
  fiscalYears?: Array<{
    fy?: number | null;
    periodEnd?: string | null;
    revenueCr?: number | null;
    netIncomeCr?: number | null;
    ebitdaCr?: number | null;
    operatingCashflowCr?: number | null;
    freeCashflowCr?: number | null;
  }>;
  growth?: {
    earningsGrowthPct?: number | null;
    revenueGrowthPct?: number | null;
    profitMarginsPct?: number | null;
    returnOnEquityPct?: number | null;
  };
  fetchedAt?: string | null;
  source?: string | null;
}

export function stockFinancialsDocument(
  stockId: number,
  symbol: string,
  companyName: string,
  raw: unknown,
): KnowledgeDocument | null {
  if (raw === null || typeof raw !== "object") return null;
  const fin = raw as StockFinancialsDoc;
  const years = Array.isArray(fin.fiscalYears) ? fin.fiscalYears : [];
  if (years.length === 0) return null;
  const src = fin.source ?? "Yahoo Finance";
  const cr = (v: number | null | undefined): string | null =>
    typeof v === "number" && Number.isFinite(v) ? `₹${v.toFixed(0)} cr` : null;
  const yearLines: string[] = [];
  for (const y of years) {
    const parts = [
      y.revenueCr != null ? `revenue ${cr(y.revenueCr)}` : null,
      y.netIncomeCr != null ? `net profit ${cr(y.netIncomeCr)}` : null,
      y.ebitdaCr != null ? `EBITDA ${cr(y.ebitdaCr)}` : null,
      y.operatingCashflowCr != null ? `operating cash flow ${cr(y.operatingCashflowCr)}` : null,
      y.freeCashflowCr != null ? `free cash flow ${cr(y.freeCashflowCr)}` : null,
    ].filter((x): x is string => x !== null);
    if (parts.length === 0) continue;
    yearLines.push(`FY${y.fy ?? "?"} (ending ${y.periodEnd ?? "unknown"}): ${parts.join(", ")}.`);
  }
  if (yearLines.length === 0) return null;
  const g: string[] = [];
  if (typeof fin.growth?.revenueGrowthPct === "number") g.push(`revenue ${fin.growth.revenueGrowthPct >= 0 ? "+" : ""}${fin.growth.revenueGrowthPct.toFixed(1)}% YoY`);
  if (typeof fin.growth?.earningsGrowthPct === "number") g.push(`net profit ${fin.growth.earningsGrowthPct >= 0 ? "+" : ""}${fin.growth.earningsGrowthPct.toFixed(1)}% YoY`);
  if (typeof fin.growth?.profitMarginsPct === "number") g.push(`profit margin ${fin.growth.profitMarginsPct.toFixed(1)}%`);
  if (typeof fin.growth?.returnOnEquityPct === "number") g.push(`ROE ${fin.growth.returnOnEquityPct.toFixed(1)}%`);
  const title = `${symbol} fiscal-year financial statements`;
  const content = `Annual financial statements for ${companyName} (${symbol}) as reported by ${src}${fin.fetchedAt ? ` (retrieved ${fin.fetchedAt.slice(0, 10)})` : ""}: ${yearLines.join(" ")}${g.length > 0 ? ` Year-over-year trend: ${g.join(", ")}.` : ""} These figures come from the provider's annual-report data, cached in the structured database; the AI layer quotes them but never recomputes them.`;
  return {
    meta: meta(
      {
        documentId: `FINSTMT:${symbol}`,
        documentType: "FINANCIAL_INFORMATION",
        source: src,
        stockSymbol: symbol,
        stockId,
        publishedAt: fin.fetchedAt ?? null,
        confidence: 1,
        indexedAt: null,
      },
      title,
      content,
    ),
    title,
    content,
  };
}

// ---------------------------------------------------- HISTORICAL_EVENT
export function historicalEventDocument(e: Parameters<typeof eventDocument>[0] & { articleCount?: number }): KnowledgeDocument | null {
  if (e.status && e.status !== "RESOLVED" && e.status !== "PROCESSED" && e.status !== "EXPIRED") return null;
  const doc = eventDocument(e);
  if (!doc) return null;
  return {
    meta: { ...doc.meta, documentType: "HISTORICAL_EVENT" as DocumentType, documentId: `HIST:${e.event_id}` },
    title: doc.title,
    content: doc.content,
  };
}

// ----------------------------------------------------------- INDEX ALL
export interface IndexSources {
  news: Array<Parameters<typeof newsArticleDocument>[0]>;
  events: Array<Parameters<typeof eventDocument>[0]>;
  stocks: Array<Parameters<typeof stockDocument>[0]>;
  snapshots: Array<Parameters<typeof riskSnapshotDocument>[0]>;
}

/** Load bounded, current data from PostgreSQL and build the document set. */
export async function buildDocuments(prisma: PrismaClient, limits: { news: number; events: number; snapshots: number }): Promise<KnowledgeDocument[]> {
  const [news, events, stocks, snapshots, financials] = await Promise.all([
    prisma.intelligence_news_articles.findMany({
      orderBy: { published_at: "desc" },
      take: limits.news,
      select: { article_id: true, provider: true, title: true, description: true, url: true, source_name: true, published_at: true, language: true },
    }),
    prisma.intelligence_news_events.findMany({
      orderBy: { detected_at: "desc" },
      take: limits.events,
      select: { event_id: true, category: true, title: true, summary: true, severity: true, relevance: true, confidence: true, detected_at: true, status: true },
    }),
    prisma.stocks.findMany({ select: { stock_id: true, symbol: true, company_name: true, sector: true, exchange: true, description: true } }),
    prisma.portfolio_risk_snapshots.findMany({
      orderBy: { snapshot_date: "desc" },
      take: limits.snapshots,
      select: { snapshot_id: true, portfolio_id: true, snapshot_date: true, volatility: true, sharpe: true, max_drawdown: true, beta: true, var_95: true, calculation_version: true },
    }),
    // Req 7: FY financial statements — deterministic projections of the
    // cached provider document so the LLM can quote revenue/profit/EPS
    // facts without the research prompt carrying every company's numbers.
    prisma.stocks.findMany({
      where: { financials: { not: Prisma.DbNull } },
      select: { stock_id: true, symbol: true, company_name: true, financials: true },
    }),
  ]);

  const docs: KnowledgeDocument[] = [];
  for (const a of news) {
    const d = newsArticleDocument(a);
    if (d) docs.push(d);
  }
  for (const e of events) {
    const d = eventDocument(e);
    if (d) docs.push(d);
    const h = historicalEventDocument(e);
    if (h && h.meta.documentId !== d?.meta.documentId) docs.push(h);
  }
  for (const s of stocks) docs.push(stockDocument(s));
  for (const r of snapshots) {
    const d = riskSnapshotDocument(r);
    if (d) docs.push(d);
  }
  for (const s of financials) {
    const d = stockFinancialsDocument(s.stock_id, s.symbol, s.company_name, s.financials);
    if (d) docs.push(d);
  }
  return docs;
}
