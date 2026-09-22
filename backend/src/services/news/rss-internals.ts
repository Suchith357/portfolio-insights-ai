/**
 * Test-internals for the news aggregation layer (Req 1 tests).
 *
 * Exposes the pure/deterministic parts of rss.providers.ts and
 * news-registry.ts (XML parsing, dedup, relevance, aggregator scheduling)
 * WITHOUT network access: the aggregator is exercised with fake providers.
 * A single side-module keeps test-only surface area out of the production
 * files.
 */
import type { NormalizedArticle, NewsProvider } from "./news-provider.js";

// Re-export the pure functions under stable test-facing names.
export { extractItems } from "./rss.providers.js";
export { dedupeArticles as dedupeArticlesPublic } from "./news-registry.js";
export { isRelevantForMarketFeed } from "./news-ingest.js";

/** Deterministic article factory for tests. */
export function makeArticle(overrides: Partial<NormalizedArticle> = {}): NormalizedArticle {
  return {
    providerArticleId: overrides.providerArticleId ?? "id-" + Math.random().toString(16).slice(2),
    title: overrides.title ?? "Test article",
    description: overrides.description ?? null,
    url: overrides.url ?? "https://example.com/test",
    sourceName: overrides.sourceName ?? "example.com",
    language: "en",
    publishedAt: overrides.publishedAt ?? new Date(),
    entities: [],
    metadata: {},
  };
}

interface FakeProviderSpec {
  id: string;
  /** Number of distinct articles the provider returns. */
  articles?: number;
  /** Throw instead of returning (simulates 429/timeout/network failure). */
  error?: Error;
  /** Called when the provider's fetch starts (for concurrency probing). */
  onCall?: () => void | Promise<void>;
  /** Called when the provider's fetch settles. */
  onDone?: () => void;
}

/**
 * Drive the real aggregator with fake providers. Returns its result plus the
 * providers used, so tests can assert on outcomes without any network I/O.
 */
export async function aggregateForTest(
  specs: FakeProviderSpec[],
  concurrencyLimit?: number,
): Promise<{ result: Awaited<ReturnType<typeof import("./news-registry.js").fetchFromAllProviders>>; providers: NewsProvider[] }> {
  const registry = await import("./news-registry.js");
  const prevLimit = process.env["NEWS_AGGREGATOR_CONCURRENCY"];
  if (concurrencyLimit !== undefined) process.env["NEWS_AGGREGATOR_CONCURRENCY"] = String(concurrencyLimit);
  try {
    const providers: NewsProvider[] = specs.map((spec) => ({
      id: spec.id,
      displayName: spec.id,
      isConfigured: () => true,
      configurationIssues: () => [],
      fetchMarketNews: async () => {
        await spec.onCall?.();
        try {
          if (spec.error) throw spec.error;
          return Array.from({ length: spec.articles ?? 0 }, (_, i) =>
            makeArticle({ url: `https://${spec.id}.test/${i}`, title: `${spec.id} article ${i}` }),
          );
        } finally {
          spec.onDone?.();
        }
      },
      fetchCompanyNews: async () => [],
    }));
    const result = await registry.fetchFromAllProvidersForTest(providers, { limit: 50, sinceHours: 24 });
    return { result, providers };
  } finally {
    if (prevLimit === undefined) delete process.env["NEWS_AGGREGATOR_CONCURRENCY"];
    else process.env["NEWS_AGGREGATOR_CONCURRENCY"] = prevLimit;
  }
}
