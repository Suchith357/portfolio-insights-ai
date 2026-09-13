/**
 * AI explanation layer.
 *
 * Design rule: the analytics engine produces every number; this layer only turns
 * those numbers into language. The default provider is a free, offline
 * rule-based explainer so the core product needs no paid API and no key.
 *
 * To plug in a hosted model later, implement `AiProvider` in a backend service
 * and read the key from the server environment (AI_API_KEY). Never ship a key
 * to the browser and never let the model invent figures — pass it the computed
 * metrics as context and ask only for explanation.
 */
import type { BuySimulationResult, PortfolioMetrics, SellSimulationResult } from "@/types";

export interface AiInsight {
  title: string;
  body: string;
  tone: "neutral" | "positive" | "caution";
}

export interface AiProvider {
  name: string;
  explainPortfolio(metrics: PortfolioMetrics): AiInsight[];
}

function riskLanguage(score: number | null, insufficient: boolean) {
  if (insufficient || score === null) {
    return "not yet measurable — the stored price history is too short for a reliable portfolio-level estimate";
  }
  if (score < 30) return "conservative";
  if (score < 50) return "balanced";
  if (score < 70) return "growth-tilted";
  return "aggressive";
}

export const offlineExplainer: AiProvider = {
  name: "Offline rule-based explainer (no API key required)",
  explainPortfolio(metrics: PortfolioMetrics): AiInsight[] {
    if (metrics.holdingCount === 0) {
      return [
        {
          title: "Nothing to analyse yet",
          body: "Add holdings to a portfolio and PortfolioIQ will explain its risk, diversification and sector balance here.",
          tone: "neutral",
        },
      ];
    }
    const insights: AiInsight[] = [];
    const top = metrics.sectorAllocation[0];
    const insufficient = metrics.riskDataSufficient === false || metrics.annualisedVolatilityPct === null;

    if (insufficient) {
      insights.push({
        title: "Risk statistics need more price history",
        body: `PortfolioIQ can value your ${metrics.holdingCount} position${metrics.holdingCount === 1 ? "" : "s"} today, but the stored price history is too short to estimate portfolio-level volatility, drawdown or trailing returns reliably. Once the market-data refresh has accumulated more daily observations, risk and return figures will appear here. Insufficient data is reported as such — it is never treated as low risk.`,
        tone: "neutral",
      });
    } else {
      insights.push({
        title: `Risk profile reads as ${riskLanguage(metrics.riskScore, false)}`,
        body: `The engine scores portfolio risk at ${metrics.riskScore!.toFixed(1)}/100, driven by an estimated annualised volatility of ${metrics.annualisedVolatilityPct!.toFixed(1)}% across ${metrics.holdingCount} positions. This is a description of historical behaviour in the dataset, not a forecast of future prices.`,
        tone: metrics.riskScore !== null && metrics.riskScore > 65 ? "caution" : "neutral",
      });
    }

    insights.push({
      title:
        metrics.diversificationScore > 65
          ? "Diversification is reasonably spread"
          : "Diversification is concentrated",
      body: `Diversification scores ${metrics.diversificationScore.toFixed(1)}/100. Your largest position, ${metrics.topConcentrationSymbol}, carries ${metrics.topConcentrationPct.toFixed(1)}% of portfolio value${top ? `, and ${top.sector} is the heaviest sector at ${top.pct.toFixed(1)}%` : ""}. Spreading weight across less-correlated sectors is what moves this score up.`,
      tone: metrics.diversificationScore > 65 ? "positive" : "caution",
    });

    insights.push({
      title: metrics.pnl >= 0 ? "Position is in profit overall" : "Position is below cost overall",
      body: `Against ${metrics.totalInvested.toFixed(0)} invested, current value is ${metrics.totalValue.toFixed(0)} — an unrealised ${metrics.pnl >= 0 ? "gain" : "loss"} of ${Math.abs(metrics.pnlPct).toFixed(2)}%. Returns and risk should be read together: a higher return earned with a high risk score is not the same as the same return earned with a low one.`,
      tone: metrics.pnl >= 0 ? "positive" : "caution",
    });

    return insights;
  },
};

export function explainBuySimulation(symbol: string, amount: number, result: BuySimulationResult): AiInsight {
  const dir =
    result.after.riskScore !== null && result.before.riskScore !== null && result.after.riskScore >= result.before.riskScore
      ? "increases"
      : "reduces";
  return {
    title: `${result.classification} — fit score ${result.fitScore.toFixed(1)}/10`,
    body: `Adding roughly ${amount.toLocaleString("en-IN")} of ${symbol} ${dir} measured portfolio risk and shifts diversification to ${result.after.diversificationScore.toFixed(1)}/100. ${result.reasons.join(" ")} These are historical, portfolio-relative indicators — they do not predict future returns.`,
    tone: result.fitScore >= 6 ? "positive" : "caution",
  };
}

export function explainSellSimulation(symbol: string, pct: number, result: SellSimulationResult): AiInsight {
  return {
    title: `Signal: ${result.recommendation}`,
    body: `Simulating a ${pct}% sale of ${symbol} releases about ${result.proceeds.toFixed(0)} and changes the portfolio profile as shown above. ${result.reasons.join(" ")} This is a simulation only — no transaction is recorded, and current indicators describe risk rather than certainty about future prices.`,
    tone: result.recommendation === "HOLD" ? "positive" : "caution",
  };
}
