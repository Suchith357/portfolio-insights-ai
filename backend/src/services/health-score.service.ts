/**
 * Portfolio health score (Intelligence Engine, Phase 8).
 *
 * A TRANSPARENT composite built from already-computed engine outputs.
 * Every component and weight is shown; the score is explicitly labelled
 * "PortfolioIQ Health Score" with methodology + version — never presented as
 * an objective financial truth. No hidden ML. Missing components are removed
 * and weights re-normalised (or the score is N/A if nothing is computable).
 *
 * health-score-v1 components (raw weights sum to 1.0):
 *   concentration            0.25  — 1 − normalised HHI (effective N vs holdings)
 *   risk-concentration       0.20  — 1 − top contributor's share of total risk above parity
 *   diversification ratio    0.15  — DR mapped through a soft cap at 2.0
 *   drawdown                 0.15  — 1 − |maxDD|/50% capped at 0..1
 *   volatility               0.15  — 1 − ann.vol mapped 0–60% band
 *   event exposure           0.10  — 1 − share of portfolio value affected by recent events
 */

import { prisma } from "../utils/prisma.js";
import { getRiskOverview } from "./news/quantitative-risk.service.js";

export const HEALTH_SCORE_VERSION = "health-score-v1";

export interface HealthComponent {
  name: string;
  weight: number;
  score: number | null;
  detail: string;
}

export interface HealthScore {
  version: string;
  label: string;
  score: number | null;
  band: "STRONG" | "MODERATE" | "CONCENTRATED-RISK" | "N/A";
  components: HealthComponent[];
  note: string;
}

interface HoldingLike {
  stock_id: number;
  symbol: string;
  sector: string;
  quantity: number;
}

export async function portfolioHealthScore(
  userId: number,
  portfolioId: number,
  input: { holdings: HoldingLike[]; eventExposurePct?: number | null },
): Promise<HealthScore> {
  const owned = await prisma.portfolios.findFirst({
    where: { portfolio_id: portfolioId, user_id: userId },
    select: { portfolio_id: true },
  });
  if (!owned) {
    return {
      version: HEALTH_SCORE_VERSION,
      label: "PortfolioIQ Health Score",
      score: null,
      band: "N/A",
      components: [],
      note: "Portfolio not found or not owned by you.",
    };
  }

  const components: HealthComponent[] = [];
  let weighted = 0;
  let weightUsed = 0;

  try {
    const overview = await getRiskOverview(portfolioId, input.holdings);

    // Concentration (0.25): HHI-based effective N relative to holding count.
    const hhi = overview.concentration.hhi;
    const n = input.holdings.length;
    const conc = hhi !== null && n > 0 ? Math.max(0, Math.min(1, (1 / hhi / n - 0.4) / 0.6)) : null;
    components.push({
      name: "concentration",
      weight: 0.25,
      score: conc === null ? null : Number(conc.toFixed(3)),
      detail: hhi === null ? "HHI unavailable" : `Effective ${((1 / hhi) * 1).toFixed(1)} positions vs ${n} holdings (HHI ${hhi.toFixed(3)}).`,
    });

    // Risk-concentration (0.20): top contributor share vs parity (100/n).
    const top = overview.contributors[0];
    const parity = n > 0 ? 100 / n : null;
    const topShare = top?.pctContribution ?? null;
    const rc = topShare !== null && parity !== null && parity > 0 ? Math.max(0, Math.min(1, 1 - (topShare / parity - 1) / 2)) : null;
    components.push({
      name: "risk-concentration",
      weight: 0.2,
      score: rc === null ? null : Number(rc.toFixed(3)),
      detail: topShare === null || parity === null ? "Risk decomposition unavailable" : `${top!.symbol} contributes ${topShare}% of risk vs ${parity.toFixed(1)}% parity.`,
    });

    // Diversification ratio (0.15): soft cap at 2.0 → 1.0 score.
    const dr = overview.diversificationRatio.value;
    const drScore = dr !== null && Number.isFinite(dr) ? Math.max(0, Math.min(1, dr / 2)) : null;
    components.push({
      name: "diversification-ratio",
      weight: 0.15,
      score: drScore === null ? null : Number(drScore.toFixed(3)),
      detail: dr === null ? "Diversification ratio unavailable" : `DR ${dr.toFixed(2)} (soft cap 2.0).`,
    });

    // Drawdown (0.15): 1 − |maxDD| / 50%.
    const dd = overview.portfolio.maxDrawdownPct.value;
    const ddScore = dd === null ? null : Math.max(0, Math.min(1, 1 + dd / 50));
    components.push({
      name: "drawdown",
      weight: 0.15,
      score: ddScore === null ? null : Number(ddScore.toFixed(3)),
      detail: dd === null ? "Max drawdown unavailable" : `Max drawdown ${dd.toFixed(1)}%.`,
    });

    // Volatility (0.15): 1 − ann.vol mapped across a 0–60% band.
    const vol = overview.portfolio.volatilityPctAnn.value;
    const volScore = vol === null ? null : Math.max(0, Math.min(1, 1 - vol / 60));
    components.push({
      name: "volatility",
      weight: 0.15,
      score: volScore === null ? null : Number(volScore.toFixed(3)),
      detail: vol === null ? "Volatility unavailable" : `Annualised volatility ${vol.toFixed(1)}%.`,
    });

    // Event exposure (0.10): share of value in event-affected holdings.
    const ev = input.eventExposurePct ?? null;
    const evScore = ev === null ? null : Math.max(0, Math.min(1, 1 - ev / 50));
    components.push({
      name: "event-exposure",
      weight: 0.1,
      score: evScore === null ? null : Number(evScore.toFixed(3)),
      detail: ev === null ? "No recent event-exposure data" : `${ev.toFixed(1)}% of value affected by recent events.`,
    });

    for (const c of components) {
      if (c.score !== null) {
        weighted += c.weight * c.score;
        weightUsed += c.weight;
      }
    }
  } catch {
    components.push({
      name: "risk-engine",
      weight: 1,
      score: null,
      detail: "Quantitative engine unavailable (insufficient aligned price history).",
    });
  }

  const score = weightUsed >= 0.5 ? Number(((weighted / weightUsed) * 100).toFixed(1)) : null;
  const band: HealthScore["band"] =
    score === null ? "N/A" : score >= 70 ? "STRONG" : score >= 45 ? "MODERATE" : "CONCENTRATED-RISK";

  return {
    version: HEALTH_SCORE_VERSION,
    label: "PortfolioIQ Health Score",
    score,
    band,
    components,
    note:
      "PortfolioIQ Health Score is a transparent, weighted composite of the components above. It is a relative model output — not an objective measure of financial quality and not investment advice.",
  };
}
