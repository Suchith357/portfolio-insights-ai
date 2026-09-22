/**
 * Requirement 1 (multi-provider news) tests — offline & deterministic.
 *   cd backend && npx tsx --test src/services/news/requirements-r1.test.ts
 *
 * Covers: RSS XML parsing/normalization (CDATA, entities, google-news
 * redirects, pubDate), cross-provider deduplication, relevance filter,
 * per-provider failure isolation in the aggregator, concurrency capping,
 * and provider-outcome logging shape. No network (providers are faked).
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

process.env["AI_DATA_DIR"] = process.env["AI_DATA_DIR"] ?? "/tmp/piq-req-test";

// ------------------------------------------------------ RSS parsing/normalize
describe("Req 1 — RSS parsing + normalization", async () => {
  const { extractItems } = await import("./rss-internals.js");

  test("parses CDATA titles and pubDates from a flat feed", () => {
    const xml = `<?xml version="1.0"?><rss><channel><item>
      <title><![CDATA[Reliance Q2 results: profit up 12%]]></title>
      <link>https://example.com/ril-q2</link>
      <description><![CDATA[Net profit rose on refining margins.]]></description>
      <pubDate>Tue, 22 Sep 2026 03:35:00 GMT</pubDate>
      <source url="https://example.com">Example News</source>
    </item><item>
      <title>Plain title with &amp; entity</title>
      <link>https://example.com/plain</link>
      <pubDate>Mon, 21 Sep 2026 10:00:00 GMT</pubDate>
    </item></channel></rss>`;
    const items = extractItems(xml);
    assert.equal(items.length, 2);
    assert.equal(items[0]?.title, "Reliance Q2 results: profit up 12%");
    assert.equal(items[0]?.link, "https://example.com/ril-q2");
    assert.equal(items[0]?.sourceName, "Example News");
    assert.ok(items[0]?.pubDate?.includes("Sep 2026"));
    assert.equal(items[1]?.title, "Plain title with & entity");
  });

  test("a malformed/empty feed yields zero items (never throws)", () => {
    assert.deepEqual(extractItems("not xml at all"), []);
    assert.deepEqual(extractItems(""), []);
    assert.deepEqual(extractItems("<rss><channel></channel></rss>"), []);
  });
});

// --------------------------------------------------------------- dedup logic
describe("Req 1 — cross-provider deduplication", async () => {
  const { dedupeArticlesPublic, makeArticle } = await import("./rss-internals.js");

  test("same URL from two providers collapses to one (richest copy wins)", () => {
    const a = makeArticle({ url: "https://example.com/story?utm_source=gdelt", title: "RIL profit up" });
    const b = makeArticle({ url: "https://example.com/story", title: "RIL profit up", description: "Full snippet" });
    const { unique, removed } = dedupeArticlesPublic([a, b]);
    assert.equal(unique.length, 1);
    assert.equal(removed, 1);
    assert.equal(unique[0]?.description, "Full snippet", "the copy carrying a description must win");
  });

  test("same publisher+title with different URLs (aggregator redirects) collapses", () => {
    const a = makeArticle({ url: "https://news.google.com/rss/articles/abc", title: "Same headline", sourceName: "mint" });
    const b = makeArticle({ url: "https://news.google.com/rss/articles/xyz", title: "Same headline", sourceName: "mint" });
    const { unique, removed } = dedupeArticlesPublic([a, b]);
    assert.equal(unique.length, 1);
    assert.equal(removed, 1);
  });

  test("genuinely different articles are all kept", () => {
    const a = makeArticle({ url: "https://a.com/1", title: "Story one" });
    const b = makeArticle({ url: "https://b.com/2", title: "Story two" });
    const { unique, removed } = dedupeArticlesPublic([a, b]);
    assert.equal(unique.length, 2);
    assert.equal(removed, 0);
  });
});

// ---------------------------------------------------------- relevance filter
describe("Req 1 — relevance filter (fewer, more relevant articles)", async () => {
  const { isRelevantForMarketFeed, makeArticle } = await import("./rss-internals.js");

  test("an Indian finance article passes", () => {
    const a = makeArticle({ title: "Nifty ends higher as banks rally; Sensex up 400 points" });
    assert.equal(isRelevantForMarketFeed(a), true);
  });

  test("generic world news is dropped", () => {
    const a = makeArticle({ title: "Celebrity wedding photos go viral", publishedAt: new Date() });
    assert.equal(isRelevantForMarketFeed(a), false);
  });

  test("stale articles lose recency points and may fail the bar", () => {
    const weekOld = new Date(Date.now() - 8 * 86_400_000);
    const borderline = makeArticle({ title: "Company update", publishedAt: weekOld });
    assert.equal(isRelevantForMarketFeed(borderline), false, "no finance/india tokens + old → dropped");
  });
});

// ----------------------------------------------------- aggregator isolation
describe("Req 1 — aggregator failure isolation + concurrency", async () => {
  const { aggregateForTest } = await import("./rss-internals.js");

  test("one provider failing (429/timeout) does not affect the others", async () => {
    const { result } = await aggregateForTest([
      { id: "good-a", articles: 10 },
      { id: "bad-b", error: new Error("HTTP 429 - rate limited") },
      { id: "good-c", articles: 5 },
    ]);
    assert.equal(result.articles.length, 15, "both healthy providers must contribute");
    assert.equal(result.providerOutcomes.filter((o) => o.ok).length, 2);
    const bad = result.providerOutcomes.find((o) => !o.ok);
    assert.equal(bad?.provider, "bad-b");
    assert.match(bad?.error ?? "", /429/);
  });

  test("all providers failing yields zero articles and honest outcomes (no crash)", async () => {
    const { result } = await aggregateForTest([
      { id: "bad-a", error: new Error("timeout after 15s") },
      { id: "bad-b", error: new Error("network error: ECONNREFUSED") },
    ]);
    assert.equal(result.articles.length, 0);
    assert.equal(result.providerOutcomes.filter((o) => !o.ok).length, 2);
  });

  test("empty provider results are successes with count 0 (no data ≠ error)", async () => {
    const { result } = await aggregateForTest([
      { id: "empty-a", articles: 0 },
      { id: "good-b", articles: 3 },
    ]);
    assert.equal(result.providerOutcomes.find((o) => o.provider === "empty-a")?.ok, true);
    assert.equal(result.articles.length, 3);
  });

  test("concurrency cap is respected (max in-flight ≤ limit)", async () => {
    let inFlight = 0;
    let peak = 0;
    const { result } = await aggregateForTest(
      Array.from({ length: 8 }, (_, i) => ({
        id: `p${i}`,
        articles: 1,
        onCall: () => {
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          // Simulate provider latency.
          return new Promise<void>((r) => setTimeout(r, 5));
        },
        onDone: () => {
          inFlight -= 1;
        },
      })),
      2,
    );
    assert.equal(result.articles.length, 8);
    assert.ok(peak <= 2, `peak concurrency ${peak} must be ≤ limit 2`);
  });
});
