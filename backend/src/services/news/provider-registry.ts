/**
 * Provider registry + selector (Intelligence Engine, Phase 1).
 *
 * Chooses the env-configured provider and transparently falls back to GDELT
 * (keyless) when the configured one is unavailable — the news subsystem then
 * reports degraded status instead of failing the pipeline.
 */
import { env } from "../../utils/env.js";
import type { NewsProvider } from "./news-provider.js";
import { GdeltProvider } from "./gdelt.provider.js";
import { MarketauxProvider } from "./marketaux.provider.js";

const GDELT = new GdeltProvider();
const MARKETAUX = new MarketauxProvider();

/** Every implemented provider (for admin diagnostics). */
export const allProviders = (): NewsProvider[] => [GDELT, MARKETAUX];

/**
 * The active provider. When the env-selected provider is not configured
 * (e.g. Marketaux token missing) the keyless GDELT provider is used so the
 * pipeline keeps functioning; status endpoints surface the degradation.
 */
export function activeProvider(): { provider: NewsProvider; degradedFrom: string | null } {
  const selected = env.newsProvider === "MARKETAUX" ? MARKETAUX : GDELT;
  if (selected.isConfigured()) return { provider: selected, degradedFrom: null };
  return { provider: GDELT, degradedFrom: selected.id };
}
