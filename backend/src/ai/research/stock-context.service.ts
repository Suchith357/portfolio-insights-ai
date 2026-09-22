/**
 * Stock research context (Prompt 4 — Deep AI Stock Research).
 *
 * Assembles the AUTHORITATIVE structured context for one stock from
 * PostgreSQL + the existing quantitative services. Every value carries
 * provenance (as-of date + source); missing data stays null — never zero,
 * never invented. The LLM receives this as read-only facts and must quote,
 * not recompute.
 */

import { prisma } from "../../utils/prisma.js";
import { getStockRiskProfile } from "../../services/analysis.service.js";
import type { StockRiskProfile } from "../../services/analytics.service.js";
import { fetchMacroContext, sectorFxSensitivity } from "../../services/market-providers/macro.providers.js";

export interface Dated<T> {
  value: T;
  asOf: string | null;
  source: string;
}

export interface StockContext {
  identity: {
    stockId: number;
    symbol: string;
    companyName: string;
    exchange: string;
    sector: string | null;
    industry: string | null;
    description: string | null;
  };
  market: {
    latestPrice: Dated<number> | null;
    previousClose: number | null;
    change1dPct: number | null;
    recentVolume: number | null;
    avgVolume20: number | null;
    volumeRatio: number | null;
    high52w: number | null;
    low52w: number | null;
    distanceFrom52wHighPct: number | null;
    staleData: boolean;
    priceAgeDays: number | null;
  };
  performance: {
    /** Period returns in %; only periods with sufficient data appear. */
    returnsPct: Array<{ period: string; pct: number | null; reason?: string }>;
    observations: number;
    dataSource: string;
  };
  fundamentals: {
    marketCapCr: number | null;
    peRatio: number | null;
    dividendYieldPct: number | null;
    asOf: string | null;
    source: string;
    /** Req 2: cached FY financials (last two fiscal years + growth); null = unavailable. */
    financials: {
      fiscalYears: Array<{
        fy: number | null;
        periodEnd: string | null;
        revenueCr: number | null;
        netIncomeCr: number | null;
        ebitdaCr: number | null;
        operatingCashflowCr: number | null;
        freeCashflowCr: number | null;
      }>;
      growth: {
        earningsGrowthPct: number | null;
        revenueGrowthPct: number | null;
        profitMarginsPct: number | null;
        returnOnEquityPct: number | null;
      };
      fetchedAt: string | null;
      source: string | null;
    } | null;
  };
  risk: {
    volatilityPct: number | null;
    maxDrawdownPct: number | null;
    riskBand: string;
    observations: number;
    insufficient: boolean;
  };
  benchmark: {
    available: boolean;
    reason: string | null;
    beta: number | null;
    alphaPctAnn: number | null;
    benchmarkReturnPctAnn: number | null;
    trackingErrorPctAnn: number | null;
    observationCount: number;
  };
  news: Array<{
    articleId: number;
    title: string;
    source: string | null;
    provider: string;
    url: string;
    publishedAt: string;
  }>;
  events: Array<{
    eventId: number;
    title: string;
    category: string;
    severity: number | null;
    confidence: number | null;
    status: string;
    relationshipType: string;
    direction: string | null;
    detectedAt: string;
    articleCount: number;
    sourceCount: number;
  }>;
  portfolio: {
    owned: boolean;
    quantity: number | null;
    avgBuyPrice: number | null;
    positionValue: number | null;
    unrealizedPnl: number | null;
    unrealizedPnlPct: number | null;
    portfolioWeightPct: number | null;
    firstBuyDate: string | null;
    holdingPeriodDays: number | null;
  };
  /** Provider-expanded macro/FX context (fail-isolated; values may be absent). */
  macro: {
    available: boolean;
    reason: string | null;
    indicators: Array<{ label: string; unit: string; year: string; value: number; source: string }>;
    fx: {
      available: boolean;
      usdInr: number | null;
      asOf: string | null;
      change1mPct: number | null;
      change3mPct: number | null;
      source: string;
    };
    /** Deterministic sector→FX-sensitivity mapping (not a computed score). */
    fxSensitivity: "HIGH" | "MODERATE" | "LOW";
  };
  freshness: {
    computedAt: string;
    priceSource: string;
    staleData: boolean;
    notes: string[];
  };
}

const DAY_MS = 86_400_000;

function pctChange(from: number, to: number): number | null {
  if (!Number.isFinite(from) || from <= 0 || !Number.isFinite(to)) return null;
  return ((to - from) / from) * 100;
}

export async function buildStockContext(symbol: string, userId: number | null, mode: "BUY" | "PORTFOLIO"): Promise<StockContext> {
  const stock = await prisma.stocks.findFirst({
    where: { symbol: symbol.toUpperCase() },
    select: {
      stock_id: true, symbol: true, company_name: true, exchange: true, sector: true, industry: true,
      description: true, market_cap: true, pe_ratio: true, dividend_yield: true, fundamentals_updated_at: true, data_source: true, financials: true,
    },
  });
  if (!stock) throw Object.assign(new Error("Unknown symbol"), { status: 404 });

  const prices = await prisma.stock_prices.findMany({
    where: { stock_id: stock.stock_id },
    orderBy: { price_date: "desc" },
    take: 1300, // ~5 years of trading days, bounded
    select: { price_date: true, open_price: true, high_price: true, low_price: true, close_price: true, volume: true, data_source: true },
  });
  const chrono = [...prices].reverse(); // oldest → newest
  const closes = chrono.map((p) => ({ date: p.price_date.toISOString().slice(0, 10), close: Number(p.close_price) }));
  const latest = chrono[chrono.length - 1];
  const latestClose = latest ? Number(latest.close_price) : null;
  const latestDate = latest ? latest.price_date.toISOString().slice(0, 10) : null;
  const latestSource = latest?.data_source ?? stock.data_source;

  const priceAgeDays = latest ? Math.floor((Date.now() - latest.price_date.getTime()) / DAY_MS) : null;
  const staleData = priceAgeDays === null || priceAgeDays > 7;

  // ---- market ------------------------------------------------------------
  const prev = chrono.length >= 2 ? Number(chrono[chrono.length - 2]!.close_price) : null;
  const volumes = chrono.slice(-60).map((p) => (p.volume === null ? null : Number(p.volume))).filter((v): v is number => v !== null);
  const recentVolume = latest?.volume === null || latest?.volume === undefined ? null : Number(latest.volume);
  const avgVolume20 = volumes.length >= 5 ? volumes.slice(-20).reduce((a, b) => a + b, 0) / Math.min(20, volumes.length) : null;

  const yearAgoIdx = chrono.length > 252 ? chrono.length - 253 : 0;
  const year = chrono.slice(yearAgoIdx);
  const high52w = year.length > 10 ? Math.max(...year.map((p) => Number(p.high_price))) : null;
  const low52w = year.length > 10 ? Math.min(...year.map((p) => Number(p.low_price))) : null;

  // ---- performance periods ----------------------------------------------
  const tradingDaysFor: Record<string, number> = { "1W": 5, "1M": 21, "3M": 63, "6M": 126, "1Y": 252, "3Y": 756, "5Y": 1260 };
  const returnsPct: StockContext["performance"]["returnsPct"] = [];
  for (const [period, days] of Object.entries(tradingDaysFor)) {
    const idx = chrono.length - 1 - days;
    if (idx < 0 || !latestClose) {
      returnsPct.push({ period, pct: null, reason: `insufficient history for ${period}` });
      continue;
    }
    const base = Number(chrono[idx]!.close_price);
    returnsPct.push({ period, pct: pctChange(base, latestClose) });
  }

  // ---- risk (existing quantitative engine) -------------------------------
  let risk: StockRiskProfile = {
    volatilityPct: null, maxDrawdownPct: null, return1yPct: null, return3yPct: null, return5yPct: null,
    riskBand: "Insufficient Data", observations: closes.length,
  };
  try {
    risk = await getStockRiskProfile(stock.symbol);
  } catch {
    /* keep the null-safe default */
  }

  // ---- benchmark (stock-level: single-series beta/alpha via engine) ------
  // benchmarkPerformance() is portfolio-scoped; for stock research we report
  // stock-vs-benchmark returns from closes when NIFTY history exists.
  const bench = await prisma.benchmarks.findFirst({ where: { is_active: true } });
  let benchmark: StockContext["benchmark"] = { available: false, reason: "No benchmark configured", beta: null, alphaPctAnn: null, benchmarkReturnPctAnn: null, trackingErrorPctAnn: null, observationCount: 0 };
  if (bench) {
    const benchPrices = await prisma.benchmark_prices.findMany({
      where: { benchmark_id: bench.benchmark_id },
      orderBy: { price_date: "desc" },
      take: 1300,
      select: { price_date: true, close_price: true },
    });
    if (benchPrices.length < 31) {
      benchmark = { ...benchmark, reason: `Only ${benchPrices.length} benchmark observations — insufficient`, observationCount: benchPrices.length };
    } else {
      const benchMap = new Map(benchPrices.map((b) => [b.price_date.toISOString().slice(0, 10), Number(b.close_price)]));
      const paired = closes.filter((c) => benchMap.has(c.date));
      if (paired.length >= 31) {
        // stock vs benchmark 1Y return + simple beta over paired daily returns
        const oneYearAgo = new Date(Date.now() - 365 * DAY_MS).toISOString().slice(0, 10);
        const yearPaired = paired.filter((p) => p.date >= oneYearAgo);
        const firstStock = yearPaired[0]?.close ?? null;
        const lastPaired = yearPaired.length > 0 ? yearPaired[yearPaired.length - 1] : undefined;
        const firstBench = yearPaired.length > 0 && lastPaired ? benchMap.get(lastPaired.date) ?? null : null;
        const benchmarkReturnPctAnn = firstStock !== null && firstBench !== null && lastPaired ? pctChange(firstBench, benchMap.get(lastPaired.date)!) : null;
        const stockReturn1y = firstStock !== null && latestClose !== null ? pctChange(firstStock, latestClose) : null;
        // daily paired returns → beta = cov/var
        const rs: number[] = [];
        const rb: number[] = [];
        for (let i = 1; i < paired.length; i++) {
          const b0 = benchMap.get(paired[i - 1]!.date)!;
          const b1 = benchMap.get(paired[i]!.date)!;
          if (paired[i - 1]!.close > 0 && b0 > 0) {
            rs.push(paired[i]!.close / paired[i - 1]!.close - 1);
            rb.push(b1 / b0 - 1);
          }
        }
        let beta: number | null = null;
        if (rs.length >= 30) {
          const mr = rs.reduce((a, b) => a + b, 0) / rs.length;
          const mb = rb.reduce((a, b) => a + b, 0) / rb.length;
          let cov = 0, varb = 0;
          for (let i = 0; i < rs.length; i++) {
            cov += (rs[i]! - mr) * (rb[i]! - mb);
            varb += (rb[i]! - mb) ** 2;
          }
          beta = varb > 0 ? cov / varb : null;
        }
        benchmark = {
          available: true,
          reason: null,
          beta,
          alphaPctAnn: beta !== null && stockReturn1y !== null && benchmarkReturnPctAnn !== null
            ? stockReturn1y - (beta * benchmarkReturnPctAnn) // simple Jensen form over the window
            : null,
          benchmarkReturnPctAnn,
          trackingErrorPctAnn: null,
          observationCount: paired.length,
        };
      } else {
        benchmark = { ...benchmark, reason: "Insufficient date-aligned stock/benchmark overlap", observationCount: paired.length };
      }
    }
  }

  // ---- news + events ------------------------------------------------------
  const newsRows = await prisma.intelligence_news_articles.findMany({
    orderBy: { published_at: "desc" },
    take: 12,
    where: { entities: { some: { stock_id: stock.stock_id } } },
    select: { article_id: true, title: true, source_name: true, provider: true, url: true, published_at: true },
  });
  const eventRows = await prisma.intelligence_event_entities.findMany({
    where: { stock_id: stock.stock_id },
    orderBy: { event_entity_id: "desc" },
    take: 8,
    select: {
      relationship_type: true,
      event: {
        select: {
          event_id: true, title: true, category: true, severity: true, confidence: true, status: true,
          detected_at: true, article_count: true, source_names: true,
        },
      },
    },
  });

  // ---- portfolio context ---------------------------------------------------
  const portfolio = { owned: false, quantity: null, avgBuyPrice: null, positionValue: null, unrealizedPnl: null, unrealizedPnlPct: null, portfolioWeightPct: null, firstBuyDate: null, holdingPeriodDays: null } as StockContext["portfolio"];
  if (userId !== null) {
    const holdings = await prisma.holdings.findMany({
      where: { stock_id: stock.stock_id, portfolios: { user_id: userId } },
    });
    if (holdings.length > 0) {
      portfolio.owned = true;
      const qty = holdings.reduce((s, h) => s + Number(h.quantity), 0);
      const cost = holdings.reduce((s, h) => s + Number(h.quantity) * Number(h.average_buy_price), 0);
      portfolio.quantity = qty;
      portfolio.avgBuyPrice = qty > 0 ? cost / qty : null;
      portfolio.positionValue = latestClose !== null ? qty * latestClose : null;
      portfolio.unrealizedPnl = portfolio.positionValue !== null ? portfolio.positionValue - cost : null;
      portfolio.unrealizedPnlPct = cost > 0 && portfolio.unrealizedPnl !== null ? (portfolio.unrealizedPnl / cost) * 100 : null;
      const totalValue = await prisma.$queryRawUnsafe<Array<{ total: number | null }>>(
        `SELECT SUM(h.quantity * sp.close_price) AS total
           FROM holdings h
           JOIN portfolios pf ON pf.portfolio_id = h.portfolio_id
           JOIN LATERAL (SELECT close_price FROM stock_prices WHERE stock_id = h.stock_id ORDER BY price_date DESC LIMIT 1) sp ON TRUE
          WHERE pf.user_id = $1`,
        userId,
      );
      const total = totalValue[0]?.total;
      portfolio.portfolioWeightPct = total && Number(total) > 0 && portfolio.positionValue !== null ? (portfolio.positionValue / Number(total)) * 100 : null;
      const firstTxn = await prisma.transactions.findFirst({
        where: { stock_id: stock.stock_id, portfolios: { user_id: userId }, transaction_type: "BUY" },
        orderBy: { transaction_date: "asc" },
        select: { transaction_date: true },
      });
      portfolio.firstBuyDate = firstTxn?.transaction_date.toISOString().slice(0, 10) ?? null;
      portfolio.holdingPeriodDays = firstTxn ? Math.floor((Date.now() - firstTxn.transaction_date.getTime()) / DAY_MS) : null;
    }
  }

  // ---- macro + FX (free/trusted provider expansion; fail-isolated) --------
  const { macro, fx } = await fetchMacroContext();
  const fxSensitivity = sectorFxSensitivity(stock.sector);

  const notes: string[] = [];
  if (staleData && latestDate) notes.push(`Latest price is ${priceAgeDays} day(s) old (${latestDate}) — treat market data as stale.`);
  if (risk.observations < 60) notes.push("Price history too short for reliable risk statistics.");
  if (!benchmark.available) notes.push(`Benchmark comparison unavailable: ${benchmark.reason}.`);

  return {
    identity: {
      stockId: stock.stock_id, symbol: stock.symbol, companyName: stock.company_name, exchange: stock.exchange,
      sector: stock.sector, industry: stock.industry, description: stock.description,
    },
    market: {
      latestPrice: latestClose !== null ? { value: latestClose, asOf: latestDate, source: latestSource === "YAHOO" ? "Yahoo Finance" : latestSource } : null,
      previousClose: prev,
      change1dPct: prev !== null ? pctChange(prev, latestClose!) : null,
      recentVolume, avgVolume20,
      volumeRatio: recentVolume !== null && avgVolume20 ? recentVolume / avgVolume20 : null,
      high52w, low52w,
      distanceFrom52wHighPct: high52w !== null && latestClose ? pctChange(high52w, latestClose) : null,
      staleData, priceAgeDays,
    },
    performance: { returnsPct, observations: closes.length, dataSource: latestSource },
    fundamentals: {
      marketCapCr: stock.market_cap === null ? null : Number(stock.market_cap),
      peRatio: stock.pe_ratio === null ? null : Number(stock.pe_ratio),
      dividendYieldPct: stock.dividend_yield === null ? null : Number(stock.dividend_yield) * 100,
      asOf: stock.fundamentals_updated_at?.toISOString() ?? null,
      source: stock.data_source === "YAHOO" ? "Yahoo Finance" : stock.data_source,
      // Req 2: FY financials pass through the cached JSONB document as-is;
      // every field is already nullable and provider-sourced (no fabrication).
      financials: (stock as { financials?: unknown }).financials
        ? ((stock as { financials: { fiscalYears?: unknown[]; growth?: Record<string, unknown>; fetchedAt?: string; source?: string } }).financials as {
            fiscalYears: Array<{ fy: number | null; periodEnd: string | null; revenueCr: number | null; netIncomeCr: number | null; ebitdaCr: number | null; operatingCashflowCr: number | null; freeCashflowCr: number | null }>;
            growth: { earningsGrowthPct: number | null; revenueGrowthPct: number | null; profitMarginsPct: number | null; returnOnEquityPct: number | null };
            fetchedAt: string | null;
            source: string | null;
          })
        : null,
    },
    risk: {
      volatilityPct: risk.volatilityPct, maxDrawdownPct: risk.maxDrawdownPct, riskBand: risk.riskBand,
      observations: risk.observations, insufficient: risk.riskBand === "Insufficient Data",
    },
    benchmark, news: newsRows.map((n) => ({ articleId: n.article_id, title: n.title, source: n.source_name, provider: n.provider, url: n.url, publishedAt: n.published_at.toISOString() })),
    events: eventRows.map((row) => {
      const sources = Array.isArray(row.event.source_names) ? (row.event.source_names as unknown[]).filter((s): s is string => typeof s === "string") : [];
      return {
        eventId: row.event.event_id, title: row.event.title, category: row.event.category, severity: row.event.severity,
        confidence: row.event.confidence === null ? null : Number(row.event.confidence), status: row.event.status,
        relationshipType: row.relationship_type, direction: null, detectedAt: row.event.detected_at.toISOString(),
        articleCount: row.event.article_count, sourceCount: sources.length,
      };
    }),
    portfolio,
    macro: {
      available: macro.ok,
      reason: macro.ok ? null : macro.reason ?? null,
      indicators: macro.indicators.map((i) => ({ label: i.label, unit: i.unit, year: i.latestYear ?? "unknown", value: i.latestValue as number, source: i.source })),
      fx: {
        available: fx.ok,
        usdInr: fx.usdInr,
        asOf: fx.asOf,
        change1mPct: fx.change1mPct,
        change3mPct: fx.change3mPct,
        source: fx.source,
      },
      fxSensitivity,
    },
    freshness: { computedAt: new Date().toISOString(), priceSource: latestSource, staleData, notes },
  };
}
