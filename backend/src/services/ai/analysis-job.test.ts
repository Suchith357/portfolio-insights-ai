/**
 * Requirements 4–6 (background analysis jobs) tests — offline & deterministic.
 *   cd backend && npx tsx --test src/services/ai/analysis-job.test.ts
 *
 * Covers: ownership isolation (getJob), resume-latest semantics
 * (getLatestJob symbol/mode/user scoping), store boundedness, and the
 * state contract. No LLM, no DB, no network — jobs are injected through the
 * documented test seam.
 */
import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";

process.env["AI_DATA_DIR"] = process.env["AI_DATA_DIR"] ?? "/tmp/piq-req-test";

describe("Req 4-6 — analysis job store", async () => {
  const store = await import("./analysis-job.service.js");
  const { getJob, getLatestJob, __injectJobForTest, __clearJobsForTest, jobCount } = store;

  beforeEach(() => __clearJobsForTest());

  const base = {
    userId: 7,
    symbol: "RELIANCE",
    mode: "BUY" as const,
    status: "COMPLETED" as const,
  };

  test("a user can poll their own job", () => {
    __injectJobForTest({ ...base, jobId: "11111111-1111-4111-8111-111111111111" });
    const job = getJob("11111111-1111-4111-8111-111111111111", 7);
    assert.ok(job);
    assert.equal(job?.symbol, "RELIANCE");
    assert.equal(job?.status, "COMPLETED");
  });

  test("a different user's job is invisible (ownership enforced)", () => {
    __injectJobForTest({ ...base, jobId: "22222222-2222-4222-8222-222222222222", userId: 7 });
    assert.equal(getJob("22222222-2222-4222-8222-222222222222", 8), null);
    assert.equal(getJob("22222222-2222-4222-8222-222222222222", 7)?.jobId, "22222222-2222-4222-8222-222222222222");
  });

  test("getLatestJob returns the most recent job for symbol+user across modes", () => {
    __injectJobForTest({
      ...base, jobId: "33333333-3333-4333-8333-333333333333", createdAt: "2026-09-22T10:00:00.000Z",
    });
    __injectJobForTest({
      ...base, jobId: "44444444-4444-4444-8444-444444444444", mode: "PORTFOLIO", status: "FAILED" as never,
      createdAt: "2026-09-22T11:00:00.000Z",
    });
    const latest = getLatestJob("RELIANCE", 7);
    assert.equal(latest?.jobId, "44444444-4444-4444-8444-444444444444");
    // Mode filter narrows correctly.
    assert.equal(getLatestJob("RELIANCE", 7, "BUY")?.jobId, "33333333-3333-4333-8333-333333333333");
    assert.equal(getLatestJob("RELIANCE", 7, "PORTFOLIO")?.status, "FAILED");
  });

  test("getLatestJob is user-scoped and symbol-scoped", () => {
    __injectJobForTest({ ...base, jobId: "55555555-5555-4555-8555-555555555555", userId: 9 });
    assert.equal(getLatestJob("RELIANCE", 7), null);
    assert.equal(getLatestJob("TCS", 9), null);
    assert.ok(getLatestJob("RELIANCE", 9));
  });

  test("job view never carries partial payloads in running states", () => {
    __injectJobForTest({ ...base, jobId: "66666666-6666-4666-8666-666666666666", status: "ANALYZING" as never });
    const job = getJob("66666666-6666-4666-8666-666666666666", 7)!;
    // Contract consumed by the frontend: report/error only when terminal.
    assert.equal(job.report, null);
    assert.equal(job.error, null);
  });

  test("store stays bounded under churn", () => {
    for (let i = 0; i < 250; i += 1) {
      __injectJobForTest({
        ...base,
        jobId: `77777777-0000-4000-8000-${String(i).padStart(12, "0")}`,
        symbol: `S${i}`,
        createdAt: new Date(Date.parse("2026-09-22T00:00:00Z") + i * 1000).toISOString(),
      });
    }
    assert.ok(jobCount() <= 200, `store size ${jobCount()} must be hard-bounded at 200`);
  });
});
