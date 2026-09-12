/**
 * Analysis & simulation — maps to `/api/analysis` on the Express backend.
 *
 * IMPORTANT: simulations are computed server-side over a hypothetical lot and
 * never write a transaction or change a holding. Demo mode keeps the original
 * in-browser engine.
 */
import { portfolioCorrelation, simulateBuy, simulateSell } from "@/lib/analytics";
import type { BuySimulationResult, Holding, SellSimulationResult } from "@/types";
import { USE_DEMO_DATA, apiRequest, delay } from "./api-client";

export async function runBuySimulation(
  holdings: Holding[],
  symbol: string,
  amount: number,
  portfolioId?: string,
): Promise<BuySimulationResult> {
  if (USE_DEMO_DATA) {
    return delay(simulateBuy(holdings, symbol, amount), 450);
  }
  if (!portfolioId) {
    throw new Error("A portfolio is required to run a buy simulation.");
  }
  void holdings;
  return apiRequest<BuySimulationResult>("/analysis/buy-simulation", {
    method: "POST",
    body: JSON.stringify({ portfolioId, symbol: symbol.toUpperCase(), amount }),
  });
}

export async function runSellSimulation(
  holdings: Holding[],
  holdingId: string,
  pct: number,
): Promise<SellSimulationResult> {
  if (USE_DEMO_DATA) {
    return delay(simulateSell(holdings, holdingId, pct), 450);
  }
  void holdings;
  return apiRequest<SellSimulationResult>("/analysis/sell-simulation", {
    method: "POST",
    body: JSON.stringify({ holdingId, pct }),
  });
}

export function correlationWithPortfolio(holdings: Holding[], symbol: string): number | null {
  // Cheap, stateless helper — kept client-side in both modes (pure maths over
  // history the detail page already loaded).
  return portfolioCorrelation(holdings, symbol);
}
