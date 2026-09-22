/**
 * Multi-provider news registry + concurrent aggregator (Requirements 1 & 13).
 *
 * Previously this module selected ONE active provider at a time, so a single
 * provider outage (GDELT HTTP 429 / timeout) starved the whole intelligence
 * pipeline. Now EVERY configured provider is queried CONCURRENTLY with a
 * concurrency cap so free providers' rate limits are respected:
 *
 *   [news-provider] GOOGLE_NEWS_RSS: SUCCESS — 32 articles (812ms)
 *   [news-provider] GDELT: HTTP 429 - rate limited (isolated, others unaffected)
 *   [news-provider] MONEYCONTROL_RSS: SUCCESS — 12 articles (1.3s)
 *   [news-registry] Aggregated: 44 raw → 29 after cross-provider dedup
 *
 * Failure semantics: one provider failing/timing out/returning 429/returning
 * malformed data NEVER fails the aggregation — its outcome is recorded as
 * data and the remaining providers continue. The preferred provider (env
 * NEWS_PROVIDER) is launched first and always gets a slot; the rest fill
 * remaining slots up to the concurrency limit.
 */
import { env } from "../../utils/env.js";
import type { FetchOptions, NewsProvider, NormalizedArticle } from "./news-provider.js";
import { GdeltProvider } from "./gdelt.provider.js";
import { MarketauxProvider } from "./marketaux.provider.js";
import { GoogleNewsRssProvider, IndiaMarketsRssProvider } from "./rss.providers.js";

const GDELT = new GdeltProvider();
const MARKETAUX = new MarketauxProvider();
const GOOGLE_NEWS = new GoogleNewsRssProvider();
const INDIA_MARKETS = new IndiaMarketsRssProvider();

/** Every implemented news provider (for admin diagnostics + aggregation). */
export const allProviders = (): NewsProvider[] => [GDELT, MARKETAUX, GOOGLE_NEWS, INDIA_MARKETS];

/** Preferred provider with keyless fallback (legacy single-provider API). */
export function activeProvider(): { provider: NewsProvider; degradedFrom: string | null } {
  const selected = env.newsProvider === "MARKETAUX" ? MARKETAUX : GDELT;
  if (selected.isConfigured()) return { provider: selected, degradedFrom: null };
  return { provider: GDELT, degradedFrom: selected.id };
}

/** All providers that are usable right now (credentials present). */
export function configuredProviders(): NewsProvider[] {
  return allProviders().filter((p) => p.isConfigured());
}

export interface ProviderOutcome {
  provider: string;
  ok: boolean;
  count: number;
  durationMs: number;
  /** Human-readable failure reason (timeout / HTTP 429 / network / etc.). */
  error: string | null;
}

export interface AggregatedFetchResult {
  articles: NormalizedArticle[];
  /** Per-provider outcome — provider failure is DATA, never a crash. */
  providerOutcomes: ProviderOutcome[];
  rawCount: number;
  /** Duplicates removed across providers (same URL, or same publisher+title). */
  duplicatesRemoved: number;
}

function preferProvider(p: NewsProvider): number {
  const preferred = env.newsProvider === "MARKETAUX" ? "marketaux" : "gdelt";
  return p.id === preferred ? 0 : 1;
}

/** Exported for the offline test harness (rss-internals.ts). */
export { dedupeArticles };

/** Normalized URL key (tracking params stripped); null when URL unusable. */
function urlKey(a: NormalizedArticle): string | null {
  try {
    const u = new URL(a.url);
    u.hash = "";
    // Strip common tracking params so the same article from two providers
    // collapses even when one wraps it in analytics junk.
    for (const p of [...u.searchParams.keys()]) {
      if (/^utm_|^ref$|^referrer$|^source$/i.test(p)) u.searchParams.delete(p);
    }
    return `url:${u.toString()}`;
  } catch {
    return null;
  }
}

/** Publisher+headline key — catches the same story behind different
 *  aggregator redirect URLs (e.g. two news.google.com article links). */
function titleKey(a: NormalizedArticle): string {
  const norm = a.title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  return `t:${(a.sourceName ?? "").toLowerCase()}::${norm}`;
}

/**
 * Cross-provider dedup with TWO keys: exact canonical URL, then
 * publisher+headline. Keeping the richest copy (the one with a description)
 * preserves the best evidence while collapsing duplicate coverage.
 */
function dedupeArticles(articles: NormalizedArticle[]): { unique: NormalizedArticle[]; removed: number } {
  const byUrl = new Map<string, NormalizedArticle>();
  const byTitle = new Map<string, NormalizedArticle>();
  const unique: NormalizedArticle[] = [];
  let removed = 0;
  for (const a of articles) {
    const uk = urlKey(a);
    const tk = titleKey(a);
    const existing = (uk !== null ? byUrl.get(uk) : undefined) ?? byTitle.get(tk);
    if (existing) {
      removed += 1;
      // Prefer the copy carrying a description/snippet (better evidence later).
      if (!existing.description && a.description) {
        existing.description = a.description;
      }
      continue;
    }
    if (uk !== null) byUrl.set(uk, a);
    byTitle.set(tk, a);
    unique.push(a);
  }
  return { unique, removed };
}

/**
 * Run provider tasks with a concurrency cap. All providers are launched
 * (concurrently where the limit allows); the preferred provider goes first.
 * `worker` MUST never throw — it catches per-provider internally.
 */
export async function fetchFromAllProviders(
  options: FetchOptions,
  query?: (provider: NewsProvider) => Promise<NormalizedArticle[]>,
): Promise<AggregatedFetchResult> {
  const providers = configuredProviders().sort((a, b) => preferProvider(a) - preferProvider(b));
  return runAggregation(providers, options, query);
}

/** Shared aggregation core (real registry + test harness). */
async function runAggregation(
  providers: NewsProvider[],
  options: FetchOptions,
  query?: (provider: NewsProvider) => Promise<NormalizedArticle[]>,
): Promise<AggregatedFetchResult> {
  const maxConcurrent = Math.max(1, Math.min(3, env.newsAggregatorConcurrency));
  const providerOutcomes: ProviderOutcome[] = [];
  const perProvider: Array<{ provider: string; articles: NormalizedArticle[] }> = [];

  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < providers.length) {
      const index = cursor;
      cursor += 1;
      const provider = providers[index];
      if (!provider) continue;
      const started = Date.now();
      try {
        const batch = await withProviderTimeout(
          provider.id,
          query ? query(provider) : provider.fetchMarketNews(options),
        );
        // Stamp per-article provenance so the store keeps the ORIGIN provider
        // (gdelt / google_news_rss / moneycontrol_rss / marketaux) even after
        // aggregation flattens the batches.
        const stamped = batch.map((a) => ({
          ...a,
          metadata: { ...a.metadata, originProvider: provider.id },
        }));
        perProvider.push({ provider: provider.id, articles: stamped });
        providerOutcomes.push({
          provider: provider.id,
          ok: true,
          count: batch.length,
          durationMs: Date.now() - started,
          error: null,
        });
        console.log(
          `[news-provider] ${provider.id}: SUCCESS — ${batch.length} article(s) (${Date.now() - started}ms)`,
        );
      } catch (error) {
        // Avoid doubled provider prefixes ("gdelt: gdelt: …") when the error
        // already carries one from the provider layer.
        const raw = error instanceof Error ? error.message : String(error);
        const message = /^\w[\w-]*: /.test(raw) && raw.startsWith(`${provider.id}: `)
          ? raw.slice(provider.id.length + 2)
          : raw;
        providerOutcomes.push({
          provider: provider.id,
          ok: false,
          count: 0,
          durationMs: Date.now() - started,
          error: message.slice(0, 200),
        });
        // Requirement 13: readable, provider-attributed failure lines.
        console.warn(`[news-provider] ${provider.id}: FAILED — ${message.slice(0, 200)}`);
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(maxConcurrent, providers.length) }, worker));

  const raw = perProvider.flatMap((p) => p.articles);
  const { unique, removed } = dedupeArticles(raw);
  console.log(
    `[news-registry] Aggregated from ${providers.length} provider(s): ${raw.length} raw → ${unique.length} after cross-provider dedup (${removed} duplicates)`,
  );
  return { articles: unique, providerOutcomes, rawCount: raw.length, duplicatesRemoved: removed };
}

/**
 * Test seam: run the aggregator over an INJECTED provider list (offline
 * tests). Production callers use fetchFromAllProviders, which resolves the
 * registry from env. Identical execution path otherwise.
 */
export async function fetchFromAllProvidersForTest(
  providers: NewsProvider[],
  options: FetchOptions,
  query?: (provider: NewsProvider) => Promise<NormalizedArticle[]>,
): Promise<AggregatedFetchResult> {
  return runAggregation(providers, options, query);
}

/** Hard per-provider call bound: even a stuck fetch cannot stall the aggregator. */
async function withProviderTimeout<T>(providerId: string, promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${providerId}: exceeded aggregator timeout (${env.newsAggregatorTimeoutMs / 1000}s)`)),
      env.newsAggregatorTimeoutMs,
    );
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
