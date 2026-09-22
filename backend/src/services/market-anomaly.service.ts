/**
 * Market anomaly detection (Requirement 1).
 *
 * Every anomaly run (startup + every scheduled ingest tick, i.e. effectively
 * the 45-minute cadence) compares the LATEST price movement of each active
 * stock — and each sector the user actually holds — against its own 90-day
 * history, using a documented z-score rule:
 *
 *   daily return r, history window N=90 days
 *   z = (r − mean(hist)) / std(hist)
 *   |z| ≥ ANOMALY_STD_DEV_THRESHOLD (default 2.0) AND |r| ≥ 1.5%
 *
 * → deterministic anomaly alert (source 'ANALYTICS', plain-language copy).
 *
 * Guarantees:
 *  - BACKEND CALCULATION only — no AI/LLM involved anywhere in detection.
 *  - Per-user, per-day dedup (one anomaly alert per stock/sector per user per
 *    day) reuses the analytics alert pattern; a silent anomaly is not retried.
 *  - Missing prices/history → the stock is skipped (never fabricated, never 0).
 *  - One failing stock/sector never stops the run.
 *  - Reuses latestHomogeneousSegment so DEMO/YAHOO sources are never mixed.
 */
import { prisma } from "../utils/prisma.js";
import { env } from "../utils/env.js";
import { recordAudit } from "../utils/audit.js";
import { latestHomogeneousSegment } from "./analytics.service.js";

const HISTORY_DAYS = 90;
const MIN_ABS_RETURN_PCT = 1.5; // z-score alone flags micro-moves; require a real move too

/** A single computed anomaly candidate. */
export interface AnomalyFinding {
  kind: "STOCK" | "SECTOR";
  key: string; // stock_id or sector name
  symbolOrSector: string;
  displayName: string;
  returnPct: number; // latest-day move
  z: number;
  meanPct: number;
  stdPct: number;
  observations: number;
  closePrice: number | null;
  asOf: string; // price date ISO
  direction: "UP" | "DOWN";
}

/** Result of one anomaly scan. */
export interface AnomalyRunResult {
  status: "SUCCESS" | "PARTIAL" | "FAILED";
  stocksScanned: number;
  sectorsScanned: number;
  anomaliesFound: number;
  alertsCreated: number;
  duplicatesSkipped: number;
  failures: number;
  message: string | null;
  findings: Array<Pick<AnomalyFinding, "kind" | "symbolOrSector" | "returnPct" | "z" | "asOf" | "direction">>;
}

let running = false;
/** True while an anomaly scan is in flight (single-flight guard). */
export function isAnomalyScanRunning(): boolean {
  return running;
}

function mean(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}

function stdSample(xs: number[]): number {
  const n = xs.length;
  if (n < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (n - 1));
}

/** Latest trading day's simple return (%); null when < 2 usable closes. */
function latestReturnPct(closes: Array<{ price_date: Date; close_price: bigint | number }>): { r: number; asOf: string } | null {
  if (closes.length < 2) return null;
  const last = closes[closes.length - 1]!;
  const prev = closes[closes.length - 2]!;
  const prevClose = Number(prev.close_price);
  if (!(prevClose > 0)) return null;
  return {
    r: (Number(last.close_price) / prevClose - 1) * 100,
    asOf: last.price_date.toISOString().slice(0, 10),
  };
}

/**
 * Core rule, exported for tests: z-score + minimum absolute move.
 * Returns null when the observation is not anomalous (or history too thin).
 */
export function evaluateAnomaly(
  returnPct: number,
  historyReturnsPct: number[],
  thresholdStdDev: number = env.anomalyStdDevThreshold,
): { z: number; meanPct: number; stdPct: number } | null {
  const hist = historyReturnsPct.slice(0, HISTORY_DAYS);
  if (hist.length < 20) return null; // need a real baseline
  const m = mean(hist);
  const s = stdSample(hist);
  // Epsilon floor: a numerically flat history still yields std ≈ 1e-16 from
  // float rounding — that is "no dispersion", not "extreme outlier".
  if (!(s > 1e-9)) return null;
  const z = (returnPct - m) / s;
  if (Math.abs(z) < thresholdStdDev || Math.abs(returnPct) < MIN_ABS_RETURN_PCT) return null;
  return { z, meanPct: m, stdPct: s };
}

/** Plain-language copy. Professional, short; no advice, no predictions. */
function anomalyCopy(f: AnomalyFinding): { title: string; message: string } {
  const dirWord = f.direction === "UP" ? "jumped" : "dropped";
  const what =
    f.kind === "STOCK"
      ? `${f.symbolOrSector} ${dirWord} ${Math.abs(f.returnPct).toFixed(1)}% on ${f.asOf}`
      : `${f.symbolOrSector} sector ${dirWord} ${Math.abs(f.returnPct).toFixed(1)}% on average on ${f.asOf}`;
  const why =
    f.kind === "STOCK"
      ? `That move is ${Math.abs(f.z).toFixed(1)} standard deviations beyond its own last 90 trading days (typical day: ${f.meanPct >= 0 ? "+" : ""}${f.meanPct.toFixed(2)}%, usual spread ±${f.stdPct.toFixed(2)}%).`
      : `That is ${Math.abs(f.z).toFixed(1)} standard deviations beyond the sector's own last 90 trading days.`;
  const soWhat =
    f.direction === "UP"
      ? "Sharp one-day moves often trace back to news or results — check the Intelligence feed before acting."
      : "Sharp one-day falls often trace back to news or results — check the Intelligence feed before acting.";
  return {
    title: `Unusual move detected: ${what}`,
    message: `${why} ${soWhat} Statistical alert from your own stored price history — not a prediction.`,
  };
}

/** The 90-day daily-return history for one stock (%, oldest→newest). */
function stockHistory(returns: number[]): number[] {
  return returns;
}

export async function runAnomalyScan(trigger: "STARTUP" | "SCHEDULED" | "MANUAL"): Promise<AnomalyRunResult> {
  if (running) {
    return { status: "FAILED", stocksScanned: 0, sectorsScanned: 0, anomaliesFound: 0, alertsCreated: 0, duplicatesSkipped: 0, failures: 0, message: "Anomaly scan already running.", findings: [] };
  }
  running = true;
  const result: AnomalyRunResult = {
    status: "SUCCESS", stocksScanned: 0, sectorsScanned: 0, anomaliesFound: 0,
    alertsCreated: 0, duplicatesSkipped: 0, failures: 0, message: null, findings: [],
  };

  try {
    // 1) All active stocks with price history: latest return + 90d history.
    const stocks = await prisma.stocks.findMany({
      where: { is_active: true },
      select: { stock_id: true, symbol: true, company_name: true, sector: true },
    });

    const since = new Date(Date.now() - (HISTORY_DAYS + 10) * 86_400_000);
    const prices = await prisma.stock_prices.findMany({
      where: { price_date: { gte: since } },
      select: { stock_id: true, price_date: true, close_price: true, data_source: true },
      orderBy: { price_date: "asc" },
    });

    // Group per stock → per-source homogeneous segment → returns.
    const byStock = new Map<number, Array<{ date: string; close: number; data_source: string }>>();
    for (const p of prices) {
      const arr = byStock.get(p.stock_id) ?? [];
      arr.push({ date: p.price_date.toISOString().slice(0, 10), close: Number(p.close_price), data_source: p.data_source });
      byStock.set(p.stock_id, arr);
    }

    const latestByStock = new Map<number, { r: number; asOf: string; close: number | null }>();
    const historyByStock = new Map<number, number[]>();
    for (const [stockId, rows] of byStock) {
      const seg = latestHomogeneousSegment(
        rows.map((r) => ({ date: r.date, close: r.close })),
        new Map(rows.map((r) => [r.date, r.data_source])),
      );
      if (seg.length < 2) continue;
      const last = seg[seg.length - 1]!;
      const prev = seg[seg.length - 2]!;
      if (!(prev.close > 0)) continue;
      const lr = { r: (last.close / prev.close - 1) * 100, asOf: last.date };
      latestByStock.set(stockId, { ...lr, close: last.close });
      const lr0 = latestByStock.get(stockId)!;
      latestByStock.set(stockId, lr0);
      const hist: number[] = [];
      for (let i = 1; i < seg.length - 1; i += 1) {
        const prevC = seg[i - 1]!.close;
        if (prevC > 0) hist.push((seg[i]!.close / prevC - 1) * 100);
      }
      historyByStock.set(stockId, stockHistory(hist));
    }

    // 2) Evaluate every active stock.
    const stockFindings: AnomalyFinding[] = [];
    for (const s of stocks) {
      result.stocksScanned += 1;
      const lr = latestByStock.get(s.stock_id);
      const hist = historyByStock.get(s.stock_id) ?? [];
      if (!lr) continue;
      const ev = evaluateAnomaly(lr.r, hist);
      if (!ev) continue;
      const finding: AnomalyFinding = {
        kind: "STOCK", key: String(s.stock_id), symbolOrSector: s.symbol, displayName: s.company_name,
        returnPct: lr.r, z: ev.z, meanPct: ev.meanPct, stdPct: ev.stdPct,
        observations: hist.length, closePrice: lr.close, asOf: lr.asOf,
        direction: lr.r > 0 ? "UP" : "DOWN",
      };
      result.anomaliesFound += 1;
      result.findings.push({ kind: "STOCK", symbolOrSector: s.symbol, returnPct: lr.r, z: ev.z, asOf: lr.asOf, direction: finding.direction });
      stockFindings.push(finding);
    }

    // 3) Sector-level anomalies: equal-weight average of member returns
    // evaluated against the sector's own 90-day return history (documented;
    // single-stock "sectors" are skipped — that is just the stock finding).
    const sectorFindings: AnomalyFinding[] = [];
    for (const sector of new Set(stocks.map((s) => s.sector))) {
      const members = stocks.filter((s) => s.sector === sector && latestByStock.has(s.stock_id));
      if (members.length < 2) continue;
      result.sectorsScanned += 1;
      const perDay: number[] = [];
      const histLen = Math.min(...members.map((m) => (historyByStock.get(m.stock_id)?.length ?? 0)));
      for (let i = 0; i < histLen; i += 1) {
        const vals = members
          .map((m) => historyByStock.get(m.stock_id)![historyByStock.get(m.stock_id)!.length - histLen + i])
          .filter((v): v is number => typeof v === "number");
        if (vals.length === members.length) perDay.push(mean(vals));
      }
      if (perDay.length < 21) continue; // need a real sector baseline
      const latest = perDay[perDay.length - 1]!;
      const ev = evaluateAnomaly(latest, perDay.slice(0, -1));
      if (!ev) continue;
      const finding: AnomalyFinding = {
        kind: "SECTOR", key: sector, symbolOrSector: sector, displayName: sector,
        returnPct: latest, z: ev.z, meanPct: ev.meanPct, stdPct: ev.stdPct,
        observations: perDay.length - 1, closePrice: null,
        asOf: latestByStock.get(members[0]!.stock_id)!.asOf,
        direction: latest > 0 ? "UP" : "DOWN",
      };
      result.anomaliesFound += 1;
      result.findings.push({ kind: "SECTOR", symbolOrSector: sector, returnPct: latest, z: ev.z, asOf: finding.asOf, direction: finding.direction });
      sectorFindings.push(finding);
    }

    // 4) Alert relevant users: holders of the stock (STOCK) or of any stock
    //    in the sector (SECTOR), plus watchlisters for STOCK anomalies.
    if (result.anomaliesFound > 0) {
      const all = [...stockFindings, ...sectorFindings];
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);

      for (const f of all) {
        // Audience: holders (both kinds) + watchlisters (stock only).
        const holderHoldings = await prisma.holdings.findMany({
          where: f.kind === "STOCK"
            ? { stock_id: Number(f.key) }
            : { stocks: { is: { sector: f.key } } },
          select: { portfolios: { select: { user_id: true } } },
          distinct: ["portfolio_id"],
        });
        const userIds = new Set<number>(holderHoldings.map((h) => h.portfolios.user_id));
        if (f.kind === "STOCK") {
          const watchers = await prisma.watchlists.findMany({
            where: { stock_id: Number(f.key) },
            select: { user_id: true },
          });
          for (const w of watchers) userIds.add(w.user_id);
        }

        for (const userId of userIds) {
          const dedupeWhere = {
            user_id: userId,
            alert_type: "MARKET_ANOMALY",
            title: { startsWith: `Unusual move detected: ${f.symbolOrSector} ` },
            created_at: { gte: todayStart },
          };
          const existing = await prisma.alerts.findFirst({ where: dedupeWhere, select: { alert_id: true } });
          if (existing) {
            result.duplicatesSkipped += 1;
            continue;
          }
          const copy = anomalyCopy(f);
          await prisma.alerts.create({
            data: {
              user_id: userId,
              stock_id: f.kind === "STOCK" ? Number(f.key) : null,
              alert_type: "MARKET_ANOMALY",
              severity: Math.abs(f.z) >= 3 ? "HIGH" : "MEDIUM",
              title: copy.title,
              message: copy.message,
              source: "ANALYTICS",
            },
          });
          result.alertsCreated += 1;
        }
      }

      if (result.alertsCreated > 0) {
        await recordAudit({
          userId: null,
          action: "ALERT_GENERATED",
          entityType: "market_anomaly",
          entityId: null,
          details: `trigger=${trigger} anomalies=${result.anomaliesFound} alerts=${result.alertsCreated}`,
        });
      }
    }
  } catch (error) {
    result.status = "FAILED";
    result.message = error instanceof Error ? error.message.slice(0, 200) : String(error);
    console.error("[anomaly] scan failed:", result.message);
  } finally {
    running = false;
  }

  if (result.status !== "FAILED") {
    result.status = result.failures > 0 ? "PARTIAL" : "SUCCESS";
  }
  console.log(
    `[anomaly] ${trigger} scan ${result.status}: stocks=${result.stocksScanned} sectors=${result.sectorsScanned} ` +
      `anomalies=${result.anomaliesFound} alerts=${result.alertsCreated} dup-skipped=${result.duplicatesSkipped} failures=${result.failures}`,
  );
  return result;
}

/** Alert-type whitelist constant reused by the frontend legend. */
export const ANOMALY_ALERT_TYPE = "MARKET_ANOMALY";
