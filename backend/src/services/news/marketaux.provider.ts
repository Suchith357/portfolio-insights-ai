/**
 * Marketaux provider — free tier with API token (NEWS_MARKETAUX_API_TOKEN).
 *
 * Endpoint: GET https://api.marketaux.com/v1/news/all
 *   params: api_token, symbols / entity_types=companiesticker, language=en,
 *           published_after (ISO), limit (≤ 75? free tier: 30 recommended)
 *
 * Unlike GDELT it reports structured entities (companies with tickers and
 * sentiment), which the matcher stores directly. Without a token the provider
 * reports itself unconfigured and the pipeline degrades to GDELT — the app
 * never crashes on missing credentials.
 */
import {
  assertSafeHttpUrl,
  fetchJsonWithRetry,
  parseDateSafe,
  sanitizeText,
  ProviderUnavailableError,
  type FetchOptions,
  type NewsProvider,
  type NormalizedArticle,
  type ProviderEntity,
} from "./news-provider.js";
import { env } from "../../utils/env.js";

interface MarketauxEntity {
  type?: unknown;
  name?: unknown;
  symbol?: unknown;
  relevance_score?: unknown;
  sentiment_score?: unknown;
  highlight?: unknown;
}

interface MarketauxArticle {
  uuid?: unknown;
  title?: unknown;
  description?: unknown;
  url?: unknown;
  source?: unknown; // string or { name }
  language?: unknown;
  published_at?: unknown;
  entities?: unknown;
}

function numOrNull(raw: unknown): number | null {
  const n = typeof raw === "string" ? Number(raw) : typeof raw === "number" ? raw : NaN;
  return Number.isFinite(n) ? n : null;
}

export class MarketauxProvider implements NewsProvider {
  readonly id = "marketaux";
  readonly displayName = "Marketaux";

  isConfigured(): boolean {
    return env.newsMarketauxApiToken !== null;
  }

  configurationIssues(): string[] {
    return env.newsMarketauxApiToken === null
      ? ["NEWS_MARKETAUX_API_TOKEN is not set — provider unavailable."]
      : [];
  }

  private token(): string {
    const token = env.newsMarketauxApiToken;
    if (!token) throw new ProviderUnavailableError("Marketaux API token is missing.", this.id, false);
    return token;
  }

  async fetchMarketNews(options: FetchOptions): Promise<NormalizedArticle[]> {
    return this.run({ entity_types: "companiesticker", ...this.baseParams(options) });
  }

  async fetchCompanyNews(
    symbol: string,
    companyName: string,
    options: FetchOptions,
  ): Promise<NormalizedArticle[]> {
    // Ticker-scoped query; fall back to text search shape if symbol empty.
    const params = this.baseParams(options);
    if (symbol) params.symbols = `${symbol}.NS`;
    else params.search = companyName;
    return this.run(params);
  }

  private baseParams(options: FetchOptions): Record<string, string> {
    const publishedAfter = new Date(Date.now() - options.sinceHours * 3_600_000).toISOString();
    return {
      language: "en",
      filter_entities: "true",
      published_after: publishedAfter,
      limit: String(Math.min(options.limit, 30)),
    };
  }

  private async run(params: Record<string, string>): Promise<NormalizedArticle[]> {
    const url =
      "https://api.marketaux.com/v1/news/all?" +
      new URLSearchParams({ api_token: this.token(), ...params }).toString();

    const payload = (await fetchJsonWithRetry(
      url,
      { method: "GET", headers: { Accept: "application/json" } },
      { timeoutMs: env.newsProviderTimeoutMs, retries: 2, providerId: this.id },
    )) as { data?: MarketauxArticle[] } | null;

    const rows = Array.isArray(payload?.data) ? payload!.data! : [];
    const normalized: NormalizedArticle[] = [];
    for (const a of rows) {
      const urlSafe = assertSafeHttpUrl(typeof a.url === "string" ? a.url : null);
      const title = sanitizeText(a.title, 500);
      const uuid = sanitizeText(a.uuid, 255);
      if (!urlSafe || !title || !uuid) continue;
      const publishedAt = parseDateSafe(a.published_at);
      if (!publishedAt) continue;

      const entities: ProviderEntity[] = [];
      if (Array.isArray(a.entities)) {
        for (const e of a.entities as MarketauxEntity[]) {
          const name = sanitizeText(e.name, 200);
          if (!name) continue;
          const score = numOrNull(e.sentiment_score);
          entities.push({
            name,
            type: "COMPANY",
            symbol: sanitizeText(e.symbol, 20),
            relevanceScore: numOrNull(e.relevance_score),
            sentimentScore: score === null ? null : Math.max(-1, Math.min(1, score)),
            sentimentLabel:
              score === null ? null : score > 0.15 ? "POSITIVE" : score < -0.15 ? "NEGATIVE" : "NEUTRAL",
          });
        }
      }

      const source =
        typeof a.source === "string"
          ? a.source
          : typeof (a.source as { name?: unknown } | null)?.name === "string"
            ? ((a.source as { name: string }).name as string)
            : null;

      normalized.push({
        providerArticleId: uuid,
        title,
        description: sanitizeText(a.description, 1000),
        url: urlSafe,
        sourceName: sanitizeText(source, 150),
        language: sanitizeText(a.language, 20),
        publishedAt,
        entities,
        metadata: {},
      });
    }
    return normalized;
  }
}
