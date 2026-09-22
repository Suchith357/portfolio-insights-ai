/**
 * Tests for the free/trusted provider expansion (macro + FX).
 *
 * Deterministic and offline where possible: pure functions and the TTL cache
 * are exercised without network; the wire-shape normalisation logic is tested
 * through the module's exported behaviour with fetch stubbed.
 */
import assert from "node:assert/strict";
import { test, mock } from "node:test";

// ---- pure mapping ----------------------------------------------------------
const fx = await import("./macro.providers.js");
const { sectorFxSensitivity, clearMacroCacheForTests } = fx;

test("sector FX sensitivity mapping is deterministic and sane", () => {
  assert.equal(sectorFxSensitivity("Information Technology"), "HIGH");
  assert.equal(sectorFxSensitivity("Technology"), "HIGH");
  assert.equal(sectorFxSensitivity("Energy"), "MODERATE");
  assert.equal(sectorFxSensitivity("Utilities"), "MODERATE");
  assert.equal(sectorFxSensitivity("Financial Services"), "LOW");
  assert.equal(sectorFxSensitivity(null), "LOW");
  assert.equal(sectorFxSensitivity(""), "LOW");
});

// ---- fetch failure is DATA, never an exception ------------------------------
test("fetchWorldBankMacro degrades to ok:false on network failure", async () => {
  clearMacroCacheForTests();
  const restore = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("simulated network outage");
  }) as typeof fetch;
  try {
    const snap = await fx.fetchWorldBankMacro(500);
    assert.equal(snap.ok, false);
    assert.match(snap.reason ?? "", /unavailable/);
    assert.equal(snap.indicators.length, 0);
  } finally {
    globalThis.fetch = restore;
    clearMacroCacheForTests();
  }
});

test("fetchUsdInr degrades to ok:false on network failure", async () => {
  clearMacroCacheForTests();
  const restore = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("simulated timeout");
  }) as typeof fetch;
  try {
    const snap = await fx.fetchUsdInr(500);
    assert.equal(snap.ok, false);
    assert.equal(snap.usdInr, null);
    assert.match(snap.reason ?? "", /unavailable/);
  } finally {
    globalThis.fetch = restore;
    clearMacroCacheForTests();
  }
});

// ---- World Bank wire-shape normalisation -----------------------------------
test("fetchWorldBankMacro normalises the [meta, rows] shape and skips nulls", async () => {
  clearMacroCacheForTests();
  const restore = globalThis.fetch;
  const fakeRows: Record<string, unknown> = {
    "FP.CPI.TOTL.ZG": [{}, [{ date: "2026", value: null }, { date: "2025", value: 2.4 }, { date: "2024", value: 4.95 }]],
    "NY.GDP.MKTP.KD.ZG": [{}, [{ date: "2025", value: 6.6 }, { date: "2024", value: 7.1 }]],
    "FR.INR.RINR": [{}, [{ date: "2025", value: null }]], // all null → excluded
  };
  globalThis.fetch = (async (url: string | URL) => {
    const code = String(url).split("/indicator/")[1]?.split("?")[0] ?? "";
    return { ok: true, json: async () => fakeRows[code] } as unknown as Response;
  }) as typeof fetch;
  try {
    const snap = await fx.fetchWorldBankMacro(500);
    assert.equal(snap.ok, true);
    // RINR has no non-null observation → only 2 indicators survive.
    assert.equal(snap.indicators.length, 2);
    const cpi = snap.indicators.find((i) => i.code === "FP.CPI.TOTL.ZG");
    assert.ok(cpi);
    assert.equal(cpi.latestYear, "2025"); // null 2026 skipped
    assert.equal(cpi.latestValue, 2.4);
    assert.equal(cpi.previousValue, 4.95);
    assert.match(cpi.source, /World Bank/);
  } finally {
    globalThis.fetch = restore;
    clearMacroCacheForTests();
  }
});

// ---- Frankfurter normalisation + deterministic FX math ----------------------
test("fetchUsdInr computes 1M/3M changes from the timeseries", async () => {
  clearMacroCacheForTests();
  const restore = globalThis.fetch;
  const day = 86_400_000;
  const series: Record<string, { INR: number }> = {};
  for (let i = 100; i >= 0; i--) {
    const d = new Date(Date.now() - i * day).toISOString().slice(0, 10);
    series[d] = { INR: 90 + (100 - i) * 0.05 }; // steady rise: ~90 → ~95.05
  }
  globalThis.fetch = (async (url: string | URL) => {
    const u = String(url);
    if (u.includes("/latest")) return { ok: true, json: async () => ({ date: Object.keys(series).at(-1), rates: { INR: 95.05 } }) } as unknown as Response;
    return { ok: true, json: async () => ({ rates: series }) } as unknown as Response;
  }) as typeof fetch;
  try {
    const snap = await fx.fetchUsdInr(500);
    assert.equal(snap.ok, true);
    assert.equal(snap.usdInr, 95.05);
    assert.ok(snap.change1mPct !== null && snap.change1mPct > 1, `expected rising 1M change, got ${snap.change1mPct}`);
    assert.ok(snap.change3mPct !== null && snap.change3mPct > snap.change1mPct!, "3M change should exceed 1M in a steady uptrend");
    assert.match(snap.source, /Frankfurter/);
  } finally {
    globalThis.fetch = restore;
    clearMacroCacheForTests();
  }
});

test("fetchUsdInr rejects a payload without a numeric rate", async () => {
  clearMacroCacheForTests();
  const restore = globalThis.fetch;
  globalThis.fetch = (async () => ({ ok: true, json: async () => ({ rates: {} }) })) as unknown as typeof fetch;
  try {
    const snap = await fx.fetchUsdInr(500);
    assert.equal(snap.ok, false);
    assert.match(snap.reason ?? "", /no USD\/INR/);
  } finally {
    globalThis.fetch = restore;
    clearMacroCacheForTests();
  }
});

// ---- TTL cache: second call must not re-fetch ------------------------------
test("macro snapshot is TTL-cached (no second network call within TTL)", async () => {
  clearMacroCacheForTests();
  const restore = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return { ok: true, json: async () => [{}, [{ date: "2025", value: 2.4 }]] } as unknown as Response;
  }) as typeof fetch;
  try {
    const a = await fx.fetchWorldBankMacro(500);
    const b = await fx.fetchWorldBankMacro(500);
    assert.equal(a.ok, true);
    assert.equal(b.ok, true);
    assert.equal(calls, WB_INDICATOR_COUNT, "one call per indicator, then cached");
  } finally {
    globalThis.fetch = restore;
    clearMacroCacheForTests();
  }
});

const WB_INDICATOR_COUNT = 3;

// ---- malformed World Bank payload ------------------------------------------
test("fetchWorldBankMacro survives a malformed payload", async () => {
  clearMacroCacheForTests();
  const restore = globalThis.fetch;
  globalThis.fetch = (async () => ({ ok: true, json: async () => ({ unexpected: true }) })) as unknown as typeof fetch;
  try {
    const snap = await fx.fetchWorldBankMacro(500);
    assert.equal(snap.ok, false);
    assert.equal(snap.indicators.length, 0);
  } finally {
    globalThis.fetch = restore;
    clearMacroCacheForTests();
  }
});
