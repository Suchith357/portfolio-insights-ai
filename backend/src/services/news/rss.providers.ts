/**
 * Additional FREE news providers (Requirement 1 — multi-provider aggregation).
 *
 *   1. GOOGLE_NEWS_RSS — Google News RSS search (news.google.com/rss/search).
 *      Free, keyless, no registration. XML (RSS 2.0), not JSON — parsed with
 *      a small regex-based reader because the feed is a flat <item> list.
 *      Returns rich results for company/sector queries; the <source> element
 *      names the actual publisher (Google News is an aggregator).
 *   2. MONEYCONTROL_RSS — Moneycontrol public RSS (www.moneycontrol.com/rss/*).
 *      Free, keyless. Broad Indian-market feeds; a small number of items
 *      (typically ~15 per feed) so it contributes breadth, not volume.
 *
 * Both normalize into the shared NormalizedArticle shape so the ingest
 * pipeline stays vendor-agnostic. Absent fields stay null — never fabricated.
 */
import {
  assertSafeHttpUrl,
  sanitizeText,
  parseDateSafe,
  type FetchOptions,
  type NewsProvider,
  type NormalizedArticle,
} from "./news-provider.js";
import { fetchXmlWithRetry } from "../http-xml.js";
import { env } from "../../utils/env.js";

// ---------------------------------------------------------------------------
// Shared minimal RSS parsing (flat RSS 2.0 items; CDATA + entity decoding).
// ---------------------------------------------------------------------------

/** Decode the XML escapes that actually occur in news feeds. &amp; is
 *  decoded LAST so `&amp;lt;` correctly becomes `&lt;`, not `<`. */
function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, "&");
}

/** Strip CDATA wrappers, then decode entities. */
function cleanXmlText(raw: string): string {
  const withoutCdata = raw.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
  return decodeXmlEntities(withoutCdata);
}

interface RawRssItem {
  title: string | null;
  link: string | null;
  description: string | null;
  pubDate: string | null;
  sourceName: string | null;
  sourceUrl: string | null;
}

/** Extract <item> blocks from an RSS document (feed may be single-line). */
export function extractItems(xml: string): RawRssItem[] {
  const items: RawRssItem[] = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/g;
  let m: RegExpExecArray | null;
  while ((m = itemRe.exec(xml)) !== null) {
    const body = m[1] ?? "";
    const firstTag = (name: string): string | null => {
      const re = new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, "i");
      const t = re.exec(body);
      return t?.[1] !== undefined ? cleanXmlText(t[1]) : null;
    };
    const title = firstTag("title");
    // Plain <link>URL</link>; some feeds put the URL in an href attribute.
    const plainLink = /<link[^>]*>([\s\S]*?)<\/link>/i.exec(body);
    const hrefLink = /<link[^>]*href="([^"]+)"/i.exec(body);
    const rawLink = plainLink?.[1]?.trim() ? plainLink[1] : hrefLink?.[1] ?? null;
    const sourceTag = /<source[^>]*url="([^"]*)"[^>]*>([\s\S]*?)<\/source>/i.exec(body);
    items.push({
      title,
      link: rawLink ? cleanXmlText(rawLink).trim() : null,
      description: firstTag("description"),
      pubDate: firstTag("pubDate"),
      sourceName: sourceTag?.[2] ? cleanXmlText(sourceTag[2]).trim() : null,
      sourceUrl: sourceTag?.[1] ? cleanXmlText(sourceTag[1]).trim() : null,
    });
  }
  return items;
}

/** RFC-822 pubDate → Date via the lenient parser; null when unusable. */
function parseRssDate(raw: string | null): Date | null {
  if (!raw) return null;
  // Livemint emits the non-standard "22 Sept 2026" — normalize to "Sep"
  // so the browser-grade Date parser accepts it.
  return parseDateSafe(raw.trim().replace(/\bSept\b/g, "Sep"));
}

/** FNV-1a 32-bit → hex, mirroring gdelt.provider.ts. */
function fnv1a(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** Shared implementation: build articles from any RSS feed URL. */
async function fetchRssArticles(input: {
  providerId: string;
  url: string;
  options: FetchOptions;
  mapItem: (item: RawRssItem) => NormalizedArticle | null;
}): Promise<NormalizedArticle[]> {
  const xml = await fetchXmlWithRetry(
    input.url,
    {
      method: "GET",
      headers: {
        Accept: "application/rss+xml, application/xml, text/xml, */*",
        "User-Agent": "Mozilla/5.0 (compatible; PortfolioIQ/1.0; +local academic project)",
      },
    },
    {
      timeoutMs: env.newsProviderTimeoutMs,
      retries: env.newsProviderRetries,
      providerId: input.providerId,
    },
  );

  const items = extractItems(xml);
  const cutoff = new Date(Date.now() - input.options.sinceHours * 3_600_000);
  const out: NormalizedArticle[] = [];
  for (const item of items.slice(0, Math.max(input.options.limit, 25))) {
    const urlSafe = assertSafeHttpUrl(item.link);
    const title = sanitizeText(item.title, 500);
    if (!urlSafe || !title) continue; // unusable record — skip, never fabricate
    const publishedAt = parseRssDate(item.pubDate);
    if (!publishedAt) continue;
    if (publishedAt.getTime() < cutoff.getTime()) continue; // freshness window
    const article = input.mapItem(item);
    if (article) out.push(article);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Google News RSS provider
// ---------------------------------------------------------------------------

const GOOGLE_NEWS_BASE = "https://news.google.com/rss/search";

/** RSS search operators: when:Nh / when:Nd cap the lookback server-side. */
function googleNewsWhen(sinceHours: number): string {
  return sinceHours < 24
    ? `when:${Math.max(1, Math.ceil(sinceHours))}h`
    : `when:${Math.min(30, Math.ceil(sinceHours / 24))}d`;
}

/** Build the Google News RSS search URL for a free-text query (keyless). */
function googleNewsUrl(query: string, sinceHours: number): string {
  const params = new URLSearchParams({
    q: `${query} ${googleNewsWhen(sinceHours)}`,
    hl: "en-IN",
    gl: "IN",
    ceid: "IN:en",
  });
  return `${GOOGLE_NEWS_BASE}?${params.toString()}`;
}

/** Google News item → article; carries the REAL publisher in source_name. */
function mapGoogleNewsItem(
  item: RawRssItem,
  tags: { symbol?: string; sector?: string } = {},
): NormalizedArticle | null {
  const title = sanitizeText(item.title, 500);
  const urlSafe = assertSafeHttpUrl(item.link);
  if (!title || !urlSafe) return null;
  const publishedAt = parseRssDate(item.pubDate);
  if (!publishedAt) return null;
  const fallbackHost = new URL(urlSafe).hostname;
  return {
    // Identity: publisher + title hash. Google News links are redirect URLs
    // (unique per article), so the URL itself also disambiguates copies.
    providerArticleId: fnv1a(`${sanitizeText(item.sourceName, 150) ?? fallbackHost}::${title}`),
    title,
    description: sanitizeText(item.description, 1000),
    url: urlSafe,
    sourceName: sanitizeText(item.sourceName ?? fallbackHost, 150),
    language: "en",
    publishedAt,
    entities: [],
    metadata: {
      ...(item.sourceUrl ? { sourceUrl: item.sourceUrl } : {}),
      ...(tags.symbol ? { symbol: tags.symbol } : {}),
      ...(tags.sector ? { sector: tags.sector } : {}),
      providerFamily: "google_news_rss",
    },
  };
}

export class GoogleNewsRssProvider implements NewsProvider {
  readonly id = "google_news_rss";
  readonly displayName = "Google News RSS";

  isConfigured(): boolean {
    return true; // keyless
  }

  configurationIssues(): string[] {
    return [];
  }

  async fetchMarketNews(options: FetchOptions): Promise<NormalizedArticle[]> {
    return fetchRssArticles({
      providerId: this.id,
      url: googleNewsUrl('nifty OR sensex OR "stock market" OR indian shares', options.sinceHours),
      options,
      mapItem: (item) => mapGoogleNewsItem(item),
    });
  }

  async fetchCompanyNews(symbol: string, companyName: string, options: FetchOptions): Promise<NormalizedArticle[]> {
    // Ticker first (headlines often use RIL/TCS-style short forms), then the
    // full company name; both scoped to the Indian edition.
    return fetchRssArticles({
      providerId: this.id,
      url: googleNewsUrl(`${symbol} OR "${companyName}"`, options.sinceHours),
      options,
      mapItem: (item) => mapGoogleNewsItem(item, { symbol }),
    });
  }

  async fetchSectorNews(sector: string, options: FetchOptions): Promise<NormalizedArticle[]> {
    return fetchRssArticles({
      providerId: this.id,
      url: googleNewsUrl(`${sector} sector India stocks`, options.sinceHours),
      options,
      mapItem: (item) => mapGoogleNewsItem(item, { sector }),
    });
  }
}

// ---------------------------------------------------------------------------
// Moneycontrol RSS provider → replaced by IndiaMarketsRssProvider.
//
// Verification note (recorded honestly): Moneycontrol's public RSS feeds
// (business/latestnews/economy) were live (HTTP 200) but FROZEN — newest
// item dated Apr 2024, i.e. stale by years. A provider that publishes
// nothing current contributes nothing to a freshness-windowed pipeline, so
// it is replaced by three verified-fresh Indian-markets feeds below.
// ---------------------------------------------------------------------------

/**
 * India-markets RSS provider — Economic Times Markets, Livemint Markets and
 * Business Standard Markets public feeds. All keyless, all verified fresh
 * (items published within the last hour at integration time). Contributes
 * broad Indian-market breadth that complements Google News' search results.
 */
const INDIA_MARKETS_FEEDS = [
  "https://economictimes.indiatimes.com/markets/rssfeeds/1977021501.cms",
  "https://www.livemint.com/rss/markets",
  "https://www.business-standard.com/rss/markets-106.rss",
];

/** Per-feed publisher fallback when the item lacks a <source> element. */
const FEED_FALLBACK_SOURCES = ["Economic Times", "Livemint", "Business Standard"];

function mapIndiaMarketsItem(item: RawRssItem, fallbackSource: string): NormalizedArticle | null {
  const title = sanitizeText(item.title, 500);
  const urlSafe = assertSafeHttpUrl(item.link);
  if (!title || !urlSafe) return null;
  const publishedAt = parseRssDate(item.pubDate);
  if (!publishedAt) return null;
  return {
    providerArticleId: fnv1a(urlSafe),
    title,
    description: sanitizeText(item.description, 1000),
    url: urlSafe,
    sourceName: sanitizeText(item.sourceName ?? fallbackSource, 150),
    language: "en",
    publishedAt,
    entities: [],
    metadata: { providerFamily: "india_markets_rss" },
  };
}

export class IndiaMarketsRssProvider implements NewsProvider {
  readonly id = "india_markets_rss";
  readonly displayName = "India Markets RSS (ET / Mint / B-Std)";

  isConfigured(): boolean {
    return true; // keyless public feeds
  }

  configurationIssues(): string[] {
    return [];
  }

  async fetchMarketNews(options: FetchOptions): Promise<NormalizedArticle[]> {
    // Feed-level isolation: one dead feed must not sink the provider.
    const results = await Promise.allSettled(
      INDIA_MARKETS_FEEDS.map((feedUrl, i) =>
        fetchRssArticles({
          providerId: this.id,
          url: feedUrl,
          options,
          mapItem: (item) => mapIndiaMarketsItem(item, FEED_FALLBACK_SOURCES[i] ?? "India markets"),
        }),
      ),
    );
    const out: NormalizedArticle[] = [];
    for (const r of results) {
      if (r.status === "fulfilled") out.push(...r.value);
    }
    if (results.every((r) => r.status === "rejected")) {
      // Surface a representative error so the aggregator logs it honestly.
      throw results[0]?.status === "rejected" ? results[0].reason : new Error("all India-markets feeds failed");
    }
    return out;
  }

  // These feeds are broad (no per-symbol scoping) — per the NewsProvider
  // contract, unscoped providers return empty (never fabricated) results;
  // the aggregator treats that as "no data". Google News RSS covers the
  // company/sector scoped queries for the pool.
  async fetchCompanyNews(_symbol: string, _companyName: string, _options: FetchOptions): Promise<NormalizedArticle[]> {
    return [];
  }

  async fetchSectorNews(_sector: string, _options: FetchOptions): Promise<NormalizedArticle[]> {
    return [];
  }
}
