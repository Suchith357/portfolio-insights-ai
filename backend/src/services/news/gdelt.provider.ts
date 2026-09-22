/**
 * GDELT DOC 2.0 provider — genuinely free, no API key, no registration.
 *
 * Req 1/13: GDELT is now one of SEVERAL providers queried concurrently (see
 * news-registry.ts). Its ≥5s request window is enforced by the in-module gate
 * below, so concurrent aggregation cannot violate the provider contract; a
 * 429/timeout degrades only GDELT while the other providers continue.
 *
 * Endpoint: https://api.gdeltproject.org/api/v2/doc/doc?query=...&format=json
 * Used here with:
 *   query      → sourcecountry:IN (+ optional text) — Indian-market news
 *   mode       → artlist (article list)
 *   maxrecords → capped at 75 by the API (we request fewer)
 *   timespan   → e.g. 2d/3d — recent window only
 *
 * The wire format has no article ids, so the canonical URL (already unique
 * per article in practice) is hashed into a stable provider id. Absent
 * fields stay null — nothing is fabricated.
 */
import {
  assertSafeHttpUrl,
  fetchJsonWithRetry,
  parseDateSafe,
  sanitizeText,
  type FetchOptions,
  type NewsProvider,
  type NormalizedArticle,
} from "./news-provider.js";
import { env } from "../../utils/env.js";

interface GdeltArticle {
  url?: unknown;
  title?: unknown;
  seendate?: unknown; // e.g. "20260913T081500Z"
  domain?: unknown;
  language?: unknown;
  sourcecountry?: unknown;
}

// ---------------------------------------------------------------------------
// Process-wide GDELT request gate.
//
// GDELT's DOC API allows ONE request every >=5 seconds. The gate is the
// single serialization point for EVERY query this provider makes (market,
// company, sector) and for EVERY caller (startup ingest, scheduled ingest,
// manual admin fetch). Overlapping callers FIFO-queue here instead of racing
// past the provider's limit, so HTTP 429 can only occur when GDELT itself is
// overloaded — never because two PortfolioIQ paths fired together.
// ---------------------------------------------------------------------------
const MIN_REQUEST_INTERVAL_MS = env.newsInterQueryDelayMs; // >= 5s, env-tunable
let gateTail: Promise<void> = Promise.resolve(); // FIFO chain
let lastRequestStartedAt = 0; // 0 = never issued

async function runGated<T>(label: string, run: () => Promise<T>): Promise<T> {
  const prevTail = gateTail;
  let release!: () => void;
  gateTail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await prevTail.catch(() => undefined); // wait for our turn
  try {
    // Enforce minimum spacing between request STARTS (provider contract).
    const waitMs = lastRequestStartedAt + MIN_REQUEST_INTERVAL_MS - Date.now();
    if (waitMs > 0) {
      console.log(`[gdelt] gate: waiting ${waitMs}ms before ${label} (>=5s provider window)`);
      await new Promise((r) => setTimeout(r, waitMs));
    }
    lastRequestStartedAt = Date.now();
    return await run();
  } finally {
    release(); // next queued caller proceeds (its own spacing still applies)
  }
}

/** GDELT's compact timestamp format → Date; null when unparseable. */
function parseGdeltDate(raw: unknown): Date | null {
  if (typeof raw !== "string") return null;
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(raw.trim());
  if (!m) return parseDateSafe(raw);
  const [, y, mo, d, h, mi, s] = m as unknown as [
    string, string, string, string, string, string, string,
  ];
  return new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)));
}

/** FNV-1a 32-bit → hex; deterministic, collision-safe enough for dedup keys. */
function fnv1a(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

export class GdeltProvider implements NewsProvider {
  readonly id = "gdelt";
  readonly displayName = "GDELT DOC 2.0";

  isConfigured(): boolean {
    return true; // keyless
  }

  configurationIssues(): string[] {
    return [];
  }

  async fetchMarketNews(options: FetchOptions): Promise<NormalizedArticle[]> {
    // Deliberately SIMPLE query: GDELT's DOC API is documented to take up to
    // ~60s on complex expressions, and simpler ones also match better.
    const query = `sourcecountry:IN (nifty OR sensex OR "stock market" OR shares)`;
    return this.runQuery(query, options);
  }

  async fetchCompanyNews(
    symbol: string,
    companyName: string,
    options: FetchOptions,
  ): Promise<NormalizedArticle[]> {
    // GDELT has no symbol index — fold the company name into the text query.
    const query = `sourcecountry:IN "${companyName}"`;
    return this.runQuery(query, options);
  }

  async fetchSectorNews(
    sector: string,
    options: FetchOptions,
  ): Promise<NormalizedArticle[]> {
    // Req 1: sector-level scans so held sectors are covered even when the
    // market feed has no matching keyword. Simple query per API guidance.
    const query = `sourcecountry:IN "${sector}"`;
    return this.runQuery(query, options);
  }

  private async runQuery(query: string, options: FetchOptions): Promise<NormalizedArticle[]> {
    const maxrecords = Math.min(options.limit, 75); // API hard cap
    // Req 1: the startup window can be as small as 1 hour. GDELT's DOC API
    // accepts fractional timespans like "1h"; fall back to day granularity.
    const timespan = options.sinceHours < 24 ? `${Math.max(1, Math.ceil(options.sinceHours))}h` : `${Math.min(72, Math.ceil(options.sinceHours / 24))}d`;
    const url =
      "https://api.gdeltproject.org/api/v2/doc/doc?" +
      new URLSearchParams({
        query,
        mode: "artlist",
        maxrecords: String(maxrecords),
        format: "json",
        sort: "datedesc",
        timespan,
      }).toString();

    const payload = (await runGated("gdelt query", () =>
      fetchJsonWithRetry(
        url,
        { method: "GET", headers: { "User-Agent": "PortfolioIQ/1.0 (+local academic project)" } },
        // GDELT DOC is documented slow on complex queries — give it 30s.
        // Retries are env-driven (default 1) with >=6s backoff in
        // fetchJsonWithRetry; the gate above guarantees >=5s between starts.
        { timeoutMs: Math.max(30_000, env.newsProviderTimeoutMs), retries: env.newsProviderRetries, providerId: this.id },
      ),
    )) as { articles?: GdeltArticle[] } | null;

    const articles = Array.isArray(payload?.articles) ? payload!.articles! : [];
    const normalized: NormalizedArticle[] = [];
    for (const a of articles) {
      const urlSafe = assertSafeHttpUrl(typeof a.url === "string" ? a.url : null);
      const title = sanitizeText(a.title, 500);
      if (!urlSafe || !title) continue; // unusable record — skip, never fabricate
      const publishedAt = parseGdeltDate(a.seendate);
      if (!publishedAt) continue;
      normalized.push({
        providerArticleId: fnv1a(urlSafe),
        title,
        description: null, // artlist carries no snippet field
        url: urlSafe,
        sourceName: sanitizeText(a.domain, 150),
        language: sanitizeText(a.language, 20),
        publishedAt,
        entities: [], // GDELT artlist reports no per-article entities
        metadata: { sourcecountry: sanitizeText(a.sourcecountry, 40) ?? null },
      });
    }
    return normalized;
  }
}
