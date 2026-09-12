import { prisma } from "../utils/prisma.js";
import { recordAudit } from "../utils/audit.js";
import type { PortfolioMetrics } from "./analytics.service.js";

export interface GeneratedAlert {
  alert_type: string;
  severity: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  title: string;
  message: string;
  stock_id: number | null;
}

/** Alerts whose open unread copies should block duplicates. */
const DEDUPE_TYPES = ["CONCENTRATION", "HIGH_RISK", "LOW_DIVERSIFICATION"];

/**
 * Derives alerts from analytics-engine output. Every alert has an explicit
 * reason; nothing is random. Called after a portfolio analysis.
 */
export function deriveAlerts(metrics: PortfolioMetrics, stockIdBySymbol: Map<string, number>): GeneratedAlert[] {
  const alerts: GeneratedAlert[] = [];
  if (metrics.holdingCount === 0) return alerts;

  if (metrics.topConcentrationPct > 25) {
    alerts.push({
      alert_type: "CONCENTRATION",
      severity: metrics.topConcentrationPct > 40 ? "HIGH" : "MEDIUM",
      title: `High concentration: ${metrics.topConcentrationSymbol} is ${metrics.topConcentrationPct.toFixed(1)}% of your portfolio`,
      message: `${metrics.topConcentrationPct.toFixed(1)}% of this portfolio's value sits in ${metrics.topConcentrationSymbol}. Diversification improves as no single position exceeds roughly a quarter of total value.`,
      stock_id: metrics.topConcentrationSymbol ? (stockIdBySymbol.get(metrics.topConcentrationSymbol) ?? null) : null,
    });
  }

  if (metrics.riskScore > 65) {
    alerts.push({
      alert_type: "HIGH_RISK",
      severity: metrics.riskScore > 80 ? "HIGH" : "MEDIUM",
      title: `Portfolio risk score is ${metrics.riskScore.toFixed(1)}/100`,
      message: `The analytics engine rates this portfolio ${metrics.riskScore > 80 ? "very high" : "high"} risk, driven by an estimated annualised volatility of ${metrics.annualisedVolatilityPct.toFixed(1)}%. This describes historical behaviour of the dataset, not a forecast.`,
      stock_id: null,
    });
  }

  if (metrics.diversificationScore < 40) {
    alerts.push({
      alert_type: "LOW_DIVERSIFICATION",
      severity: metrics.diversificationScore < 25 ? "HIGH" : "MEDIUM",
      title: `Diversification score is ${metrics.diversificationScore.toFixed(1)}/100`,
      message: `Value is concentrated in few positions/sectors: the heaviest sector is ${metrics.sectorAllocation[0]?.sector ?? "n/a"} at ${metrics.sectorAllocation[0]?.pct.toFixed(1) ?? 0}%. Spreading weight across more positions and sectors raises this score.`,
      stock_id: null,
    });
  }

  return alerts;
}

/**
 * Persists alerts for a portfolio, skipping types that already have an unread
 * copy for the user so the feed never fills with identical unread rows.
 * Returns how many new alerts were created.
 */
export async function generateAlertsForPortfolio(
  userId: number,
  portfolioId: number,
  metrics: PortfolioMetrics,
  stockIdBySymbol: Map<string, number>,
): Promise<number> {
  const derived = deriveAlerts(metrics, stockIdBySymbol);
  if (derived.length === 0) return 0;

  const open = await prisma.alerts.findMany({
    where: { user_id: userId, is_read: false, alert_type: { in: DEDUPE_TYPES } },
    select: { alert_type: true },
  });
  const openTypes = new Set(open.map((a) => a.alert_type));

  const fresh = derived.filter((a) => !openTypes.has(a.alert_type));
  if (fresh.length === 0) return 0;

  await prisma.alerts.createMany({
    data: fresh.map((a) => ({
      user_id: userId,
      portfolio_id: portfolioId,
      stock_id: a.stock_id,
      alert_type: a.alert_type,
      severity: a.severity,
      title: a.title,
      message: a.message,
    })),
  });
  return fresh.length;
}

/** Best-effort alert generation after an analysis; never fails the request. */
export async function generateAlertsSafely(
  userId: number,
  portfolioId: number,
  metrics: PortfolioMetrics,
  stockIdBySymbol: Map<string, number>,
): Promise<void> {
  try {
    const created = await generateAlertsForPortfolio(userId, portfolioId, metrics, stockIdBySymbol);
    if (created > 0) {
      await recordAudit({
        userId,
        action: "ALERT_GENERATED",
        entityType: "PORTFOLIO",
        entityId: portfolioId,
        details: `${created} risk alert(s) generated from portfolio analysis.`,
      });
    }
  } catch (error) {
    console.error("[alerts] generation failed", error);
  }
}
