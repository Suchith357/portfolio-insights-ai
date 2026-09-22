/**
 * XML fetch helper for RSS providers (Requirement 1).
 *
 * Mirrors fetchJsonWithRetry (news-provider.ts) but returns the raw XML
 * document. The point of a dedicated helper is honest, provider-attributed
 * error messages (Requirement 13): "[news-provider] GDELT: timeout after 15s"
 * instead of a bare "fetch failed". Every failure is a typed
 * ProviderUnavailableError with transient/permanent classification so the
 * aggregator can isolate one provider without crashing the pipeline.
 */
import { ProviderUnavailableError } from "../services/news/news-provider.js";

export async function fetchXmlWithRetry(
  url: string,
  init: RequestInit,
  options: { timeoutMs: number; retries: number; providerId: string },
): Promise<string> {
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
      if (!/<rss|<feed|<\?xml|<channel/i.test(text.slice(0, 500))) {
        throw new ProviderUnavailableError(
          `Provider returned non-XML content: ${text.slice(0, 120)}`,
          options.providerId,
          true,
        );
      }
      return text;
    } catch (error) {
      lastError = error;
      // AbortController timeouts and raw network failures surface as
      // TypeError: fetch failed / AbortError — attribute them to the provider
      // with a readable reason (timeout vs connection failure).
      const isTimeout = error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
      if (!(error instanceof ProviderUnavailableError) && lastError instanceof Error) {
        const cause = (lastError as { cause?: unknown }).cause;
        const causeMsg = cause instanceof Error ? cause.message : "";
        lastError = new ProviderUnavailableError(
          isTimeout
            ? `timeout after ${Math.round(options.timeoutMs / 1000)}s`
            : `network error${causeMsg ? `: ${causeMsg.slice(0, 120)}` : ""}`,
          options.providerId,
          true,
        );
      }
      const transient =
        (error instanceof ProviderUnavailableError && error.transient) ||
        !(error instanceof ProviderUnavailableError);
      if (!transient || attempt === options.retries) break;
      // Backoff: plain network errors wait 6s; an explicit HTTP 429 means the
      // provider is telling us to back OFF — wait ≥15s before the retry.
      const rateLimited = error instanceof ProviderUnavailableError && error.message.includes("HTTP 429");
      await new Promise((r) => setTimeout(r, (rateLimited ? 15_000 : 6_000) * (attempt + 1)));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
}
