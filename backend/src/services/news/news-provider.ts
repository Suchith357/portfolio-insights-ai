/**
 * News provider abstraction (Intelligence Engine, Phase 1).
 *
 * The intelligence subsystem must never depend on a specific vendor. Every
 * provider implements this interface and returns NORMALIZED articles; the
 * pipeline (see news-ingest.ts) knows nothing about wire formats.
 *
 * Provider contract:
 *  - `fetchMarketNews` returns the most recent items for the Indian market
 *    (freshness ordered, newest first).
 *  - `fetchCompanyNews` scopes a query to one tradable symbol when the
 *    provider supports symbol/company filtering; providers that cannot scope
 *    simply fold the company name into the text query.
 *  - Implementations MUST throw ProviderUnavailableError when credentials are
 *    missing so callers can degrade gracefully instead of crashing.
 *  - Implementations MUST NOT fabricate data: absent fields stay null.
 */
export interface NormalizedArticle {
  /** Stable identity at the provider (URL hash when the provider lacks ids). */
  providerArticleId: string;
  title: string;
  /** Snippet/summary only — never full copyrighted article bodies. */
  description: string | null;
  /** Canonical URL (http/https only; used for display and dedup). */
  url: string;
  sourceName: string | null;
  language: string | null;
  publishedAt: Date;
  /** Provider entities for the article, when the provider reports them. */
  entities: ProviderEntity[];
  /** Small provider-specific metadata blob (JSON-safe, no secrets). */
  metadata: Record<string, unknown>;
}

export interface ProviderEntity {
  name: string;
  type: "COMPANY" | "SECTOR" | "MACRO" | "PERSON" | "OTHER";
  symbol: string | null;
  relevanceScore: number | null;
  sentimentScore: number | null;
  sentimentLabel: string | null;
}

export interface FetchOptions {
  /** Hard cap on items (providers may return fewer). */
  limit: number;
  /** Only items published within this window. */
  sinceHours: number;
}

export interface NewsProvider {
  /** Stable lowercase id persisted on every article row. */
  readonly id: string;
  readonly displayName: string;
  /** True when the provider is usable right now (e.g. credentials present). */
  isConfigured(): boolean;
  /** Reasons the provider is unavailable; empty when usable. */
  configurationIssues(): string[];
  /** Broad Indian-market news feed. */
  fetchMarketNews(options: FetchOptions): Promise<NormalizedArticle[]>;
  /** News scoped to one company/symbol when supported. */
  fetchCompanyNews(symbol: string, companyName: string, options: FetchOptions): Promise<NormalizedArticle[]>;
  /**
   * News scoped to one sector name (Req 1). Providers that cannot scope by
   * sector may return an empty array — callers must treat that as "no data",
   * never as an error.
   */
  fetchSectorNews?(sector: string, options: FetchOptions): Promise<NormalizedArticle[]>;
}

/** Thrown when a provider cannot be used (missing credentials) or fails. */
export class ProviderUnavailableError extends Error {
  constructor(
    message: string,
    public readonly providerId: string,
    public readonly transient: boolean,
  ) {
    super(message);
    this.name = "ProviderUnavailableError";
  }
}

/** Minimal shared HTTP helper: timeout + retry + rate-limit handling. */
export async function fetchJsonWithRetry(
  url: string,
  init: RequestInit,
  options: { timeoutMs: number; retries: number; providerId: string },
): Promise<unknown> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt <= options.retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs);
    try {
      const res = await fetch(url, { ...init, signal: controller.signal });
      // Always drain the body — unconsumed bodies hold keep-alive sockets in
      // the undici pool and can wedge every subsequent request.
      const text = await res.text();
      if (res.status === 429) {
        throw new ProviderUnavailableError(
          `Rate limited by provider (HTTP 429). ${text.slice(0, 80)}`,
          options.providerId,
          true,
        );
      }
      if (res.status >= 500) {
        throw new ProviderUnavailableError(
          `Provider server error (HTTP ${res.status}).`,
          options.providerId,
          true,
        );
      }
      if (!res.ok) {
        // 4xx (other than 429) is a permanent request problem — do not retry.
        throw new ProviderUnavailableError(
          `Provider rejected the request (HTTP ${res.status}).`,
          options.providerId,
          false,
        );
      }
      try {
        return JSON.parse(text) as unknown;
      } catch {
        // GDELT and others may return plain-text errors with HTTP 200.
        throw new ProviderUnavailableError(
          `Provider returned non-JSON content: ${text.slice(0, 120)}`,
          options.providerId,
          true,
        );
      }
    } catch (error) {
      lastError = error;
      const transient =
        (error instanceof ProviderUnavailableError && error.transient) ||
        !(error instanceof ProviderUnavailableError);
      if (!transient || attempt === options.retries) break;
      // Backoff: plain network errors wait 6s (>= GDELT's 5s window), but an
      // explicit HTTP 429 means the provider is telling us to back OFF —
      // retrying after 6s reads as spam. Rate-limit retries therefore wait
      // 15s minimum before the single retry.
      const rateLimited = error instanceof ProviderUnavailableError && error.message.includes("HTTP 429");
      await new Promise((r) => setTimeout(r, (rateLimited ? 15_000 : 6_000) * (attempt + 1)));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
}

/**
 * Hard watchdog around any provider call. Even if a fetch ignores its
 * AbortController, the pipeline as a whole can never hang: each query is
 * bounded and its outcome is logged.
 */
export async function withWatchdog<T>(
  label: string,
  ms: number,
  promise: Promise<T>,
): Promise<T> {
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    watchdog = setTimeout(
      () => reject(new ProviderUnavailableError(`${label} exceeded ${ms}ms watchdog.`, label, true)),
      ms,
    );
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (watchdog) clearTimeout(watchdog);
  }
}

/** Only http(s) URLs may enter the system — blocks file://, data:, javascript:. */
export function assertSafeHttpUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

/** Defensive text clamp — provider payloads are untrusted input. */
export function sanitizeText(raw: unknown, maxLength: number): string | null {
  if (typeof raw !== "string") return null;
  const cleaned = raw.replace(/\s+/g, " ").trim();
  return cleaned.length > 0 ? cleaned.slice(0, maxLength) : null;
}

/** Parse a Date from arbitrary provider input; null when absent/invalid. */
export function parseDateSafe(raw: unknown): Date | null {
  if (raw instanceof Date) return Number.isNaN(raw.getTime()) ? null : raw;
  if (typeof raw !== "string" || raw.length === 0) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}
