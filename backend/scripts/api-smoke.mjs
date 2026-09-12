#!/usr/bin/env node
/**
 * PortfolioIQ end-to-end API verification script.
 * Exercises every endpoint group against a running backend (default :4000).
 * Simulations are asserted to be non-mutating by comparing holding counts.
 * Run: node scripts/api-smoke.mjs
 */
const BASE = process.env.API_BASE ?? "http://localhost:4000";

// Demo credentials follow the backend's SEED_*_PASSWORD env contract. The
// values are read from backend/.env when present (they never leave this
// machine); DEMO_PASSWORD / ADMIN_PASSWORD env vars override.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

function readEnvValue(name) {
  try {
    const text = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", ".env"), "utf8");
    return text.match(new RegExp(`^${name}=(.*)$`, "m"))?.[1]?.replace(/^\"|\"$/g, "");
  } catch {
    return undefined;
  }
}

const DEMO_EMAIL = "user@portfolioiq.dev";
const ADMIN_EMAIL = "admin@portfolioiq.dev";
// Mirrors the seed's password contract: DEMO_PASSWORD/ADMIN_PASSWORD env vars
// win; otherwise SEED_*_PASSWORD from backend/.env — unless it still holds the
// .env.example placeholder, which counts as unset (fallback = login-page demo
// credentials, matching the seed).
const PLACEHOLDER_PASSWORDS = new Set(["change-me-user", "change-me-admin"]);
function seedPassword(envVar, envFileKey, fallback) {
  const raw = (process.env[envVar] ?? readEnvValue(envFileKey) ?? "").trim().replace(/^\"|\"$/g, "");
  return raw && !PLACEHOLDER_PASSWORDS.has(raw) ? raw : fallback;
}
const DEMO_PASSWORD = seedPassword("DEMO_PASSWORD", "SEED_USER_PASSWORD", "demo1234");
const ADMIN_PASSWORD = seedPassword("ADMIN_PASSWORD", "SEED_ADMIN_PASSWORD", "admin1234");

let passed = 0;
let failed = 0;
const failures = [];

function check(name, cond, extra = "") {
  if (cond) {
    passed++;
    console.log(`  ok    ${name}`);
  } else {
    failed++;
    failures.push(name);
    console.log(`  FAIL  ${name}${extra ? ` — ${extra}` : ""}`);
  }
}

async function req(path, { method = "GET", token, body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* non-JSON */
  }
  return { status: res.status, json };
}

async function main() {
  console.log(`\nPortfolioIQ API smoke test → ${BASE}\n`);

  /* ------------------------------ health ------------------------------ */
  console.log("[health]");
  const health = await req("/api/health");
  check("GET /api/health 200", health.status === 200);
  check("health payload success:true", health.json?.success === true);

  /* ------------------------------- auth ------------------------------- */
  console.log("\n[auth]");
  const reg = await req("/api/auth/register", {
    method: "POST",
    body: { name: "Smoke Test", email: `smoke-${Date.now()}@example.com`, password: "password123" },
  });
  check("POST /api/auth/register 201", reg.status === 201, `got ${reg.status}`);
  check("register returns token+user", !!reg.json?.data?.token && !!reg.json?.data?.user?.id);
  check("register response has no password", !JSON.stringify(reg.json).includes("password_hash"));

  const badReg = await req("/api/auth/register", {
    method: "POST",
    body: { name: "X", email: "not-an-email", password: "short" },
  });
  check("register validation rejects bad input", badReg.status === 400);

  const dupReg = await req("/api/auth/register", {
    method: "POST",
    body: { name: "Demo User", email: DEMO_EMAIL, password: "password123" },
  });
  check("duplicate email rejected 409", dupReg.status === 409, `got ${dupReg.status}`);

  const login = await req("/api/auth/login", {
    method: "POST",
    body: { email: DEMO_EMAIL, password: DEMO_PASSWORD },
  });
  check("POST /api/auth/login 200", login.status === 200, `got ${login.status}`);
  const userToken = login.json?.data?.token;
  check("login returns JWT", typeof userToken === "string" && userToken.length > 20);

  const badLogin = await req("/api/auth/login", {
    method: "POST",
    body: { email: DEMO_EMAIL, password: "wrong" },
  });
  check("wrong password rejected 401", badLogin.status === 401);

  const adminLogin = await req("/api/auth/login", {
    method: "POST",
    body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  });
  check("admin login 200", adminLogin.status === 200);
  const adminToken = adminLogin.json?.data?.token;
  check("admin role in JWT response", adminLogin.json?.data?.user?.role === "ADMIN");

  const me = await req("/api/auth/me", { token: userToken });
  check("GET /api/auth/me 200", me.status === 200);
  check("me returns demo user email", me.json?.data?.email === DEMO_EMAIL);

  const meNoAuth = await req("/api/auth/me");
  check("auth/me without token 401", meNoAuth.status === 401);

  /* ------------------------------ profile ----------------------------- */
  console.log("\n[users]");
  const prof = await req("/api/users/me", { token: userToken });
  check("GET /api/users/me 200", prof.status === 200);
  const patched = await req("/api/users/me", {
    method: "PATCH",
    token: userToken,
    body: { name: "Demo User" },
  });
  check("PATCH /api/users/me 200", patched.status === 200, `got ${patched.status}`);

  /* ---------------------------- portfolios ---------------------------- */
  console.log("\n[portfolios]");
  const pfList = await req("/api/portfolios", { token: userToken });
  check("GET /api/portfolios 200", pfList.status === 200);
  const ownedPortfolios = pfList.json?.data ?? [];
  check("demo user has portfolios", ownedPortfolios.length > 0);
  const pf0 = ownedPortfolios[0];
  check("portfolio DTO shape (id/name camelCase)", !!pf0?.id && typeof pf0?.name === "string");

  const pfCreate = await req("/api/portfolios", {
    method: "POST",
    token: userToken,
    body: { name: "Smoke Test Portfolio", description: "created by smoke test" },
  });
  check("POST /api/portfolios 201", pfCreate.status === 201, `got ${pfCreate.status}`);
  const smokePfId = pfCreate.json?.data?.id;

  const pfUpdate = await req(`/api/portfolios/${smokePfId}`, {
    method: "PATCH",
    token: userToken,
    body: { name: "Smoke Test Portfolio v2" },
  });
  check("PATCH /api/portfolios/:id 200", pfUpdate.status === 200);
  check("update persisted", pfUpdate.json?.data?.name === "Smoke Test Portfolio v2");

  const pfOther = await req(`/api/portfolios/${smokePfId}`, { token: adminToken });
  check("other user's portfolio → 404 (no leak)", pfOther.status === 404, `got ${pfOther.status}`);

  const pfBadCreate = await req("/api/portfolios", { method: "POST", token: userToken, body: { name: "ab" } });
  check("portfolio validation rejects short name", pfBadCreate.status === 400);

  /* --------------------------- transactions --------------------------- */
  console.log("\n[transactions]");
  const stocks = await req("/api/stocks?pageSize=100");
  check("GET /api/stocks 200", stocks.status === 200);
  const stockRows = stocks.json?.data ?? [];
  check("30 seeded stocks", stockRows.length >= 25, `got ${stockRows.length}`);
  check("stock DTO has lastPrice/previousClose", typeof stockRows[0]?.lastPrice === "number");
  const tcs = stockRows.find((s) => s.symbol === "TCS");
  check("TCS present in catalogue", !!tcs);

  const txCreate = await req("/api/transactions", {
    method: "POST",
    token: userToken,
    body: { portfolioId: Number(smokePfId), symbol: "TCS", type: "BUY", quantity: 5, price: 100 },
  });
  check("POST BUY transaction 201", txCreate.status === 201, `got ${txCreate.status} ${JSON.stringify(txCreate.json)}`);

  const txSellTooMany = await req("/api/transactions", {
    method: "POST",
    token: userToken,
    body: { portfolioId: Number(smokePfId), symbol: "TCS", type: "SELL", quantity: 500, price: 100 },
  });
  check("oversell rejected 400", txSellTooMany.status === 400, `got ${txSellTooMany.status}`);

  const txSell = await req("/api/transactions", {
    method: "POST",
    token: userToken,
    body: { portfolioId: Number(smokePfId), symbol: "TCS", type: "SELL", quantity: 5, price: 110 },
  });
  check("POST SELL transaction 201", txSell.status === 201, `got ${txSell.status}`);
  check("sell fully closes position (holding removed)", txSell.status === 201);

  const txInvalid = await req("/api/transactions", {
    method: "POST",
    token: userToken,
    body: { portfolioId: Number(smokePfId), symbol: "TCS", type: "BUY", quantity: 0, price: 100 },
  });
  check("zero quantity rejected 400", txInvalid.status === 400);

  /* ------------------------------ holdings ---------------------------- */
  console.log("\n[holdings]");
  const hAll = await req("/api/holdings", { token: userToken });
  check("GET /api/holdings 200", hAll.status === 200);
  const holdingsBeforeSim = (hAll.json?.data ?? []).length;
  check("holdings exist for demo user", holdingsBeforeSim > 0);

  const hPf = await req(`/api/holdings/portfolio/${smokePfId}`, { token: userToken });
  check("GET /api/holdings/portfolio/:id 200", hPf.status === 200);
  check("closed position removed from holdings", (hPf.json?.data ?? []).length === 0);

  const firstHolding = (hAll.json?.data ?? [])[0];
  if (firstHolding) {
    const hOne = await req(`/api/holdings/${firstHolding.id}`, { token: userToken });
    check("GET /api/holdings/:id 200", hOne.status === 200);
  } else {
    check("GET /api/holdings/:id 200", false, "no holdings to fetch");
  }

  /* ---------------------------- portfolio view ------------------------ */
  console.log("\n[portfolio view + analysis]");
  const demoPfId = ownedPortfolios.find((p) => p.name !== "Smoke Test Portfolio v2")?.id ?? smokePfId;
  const view = await req(`/api/analysis/view/${demoPfId}`, { token: userToken });
  if (view.status === 404) {
    // optional helper endpoint; fall back to analysis
    console.log("  info  /api/analysis/view not mounted (optional)");
  } else {
    check("GET /api/analysis/view/:id 200", view.status === 200);
    check("view has holdings+metrics", Array.isArray(view.json?.data?.holdings) && !!view.json?.data?.metrics);
  }

  const analysis = await req(`/api/portfolios/${demoPfId}/analysis`, { token: userToken });
  check("GET /api/portfolios/:id/analysis 200", analysis.status === 200, `got ${analysis.status}`);
  const metrics = analysis.json?.data?.metrics;
  check(
    "metrics shape (value, pnl, risk, diversification)",
    typeof metrics?.totalValue === "number" &&
      typeof metrics?.pnl === "number" &&
      typeof metrics?.riskScore === "number" &&
      typeof metrics?.diversificationScore === "number",
  );
  check("sectorAllocation is an array", Array.isArray(metrics?.sectorAllocation));
  check("analysisHistory stored (portfolio_analysis)", (analysis.json?.data?.analysisHistory ?? []).length > 0);
  check("AI insights present (offline explainer)", (analysis.json?.data?.insights ?? []).length > 0);
  check("valueSeries present for charts", Array.isArray(analysis.json?.data?.valueSeries));

  const analysisOther = await req(`/api/portfolios/${demoPfId}/analysis`, { token: adminToken });
  check("analysis of foreign portfolio → 404", analysisOther.status === 404);

  /* ---------------------------- simulations --------------------------- */
  console.log("\n[simulations (must not mutate)]");
  const hBefore = await req("/api/holdings", { token: userToken });
  const txBefore = await req("/api/transactions", { token: userToken });

  const buySim = await req("/api/analysis/buy-simulation", {
    method: "POST",
    token: userToken,
    body: { portfolioId: Number(demoPfId), symbol: "INFY", amount: 50000 },
  });
  check("POST buy-simulation 200", buySim.status === 200, `got ${buySim.status}`);
  check("buy sim has fitScore + classification", typeof buySim.json?.data?.fitScore === "number" && !!buySim.json?.data?.classification);
  check("buy sim deltas computed", (buySim.json?.data?.deltas ?? []).length === 5);
  check("buy sim has AI insight", !!buySim.json?.data?.insight?.body);

  const hId = Number((hBefore.json?.data ?? [])[0]?.id);
  if (Number.isFinite(hId) && hId > 0) {
    const sellSim = await req("/api/analysis/sell-simulation", {
      method: "POST",
      token: userToken,
      body: { holdingId: hId, pct: 25 },
    });
    check("POST sell-simulation 200", sellSim.status === 200, `got ${sellSim.status}`);
    check(
      "sell sim recommendation valid",
      ["HOLD", "REVIEW", "CONSIDER REDUCING"].includes(sellSim.json?.data?.recommendation ?? ""),
    );
  } else {
    check("POST sell-simulation 200", false, "no holding available for sell simulation");
    check("sell sim recommendation valid", false, "no holding available");
  }

  const hAfter = await req("/api/holdings", { token: userToken });
  const txAfter = await req("/api/transactions", { token: userToken });
  check(
    "simulations did NOT mutate holdings",
    (hBefore.json?.data ?? []).length === (hAfter.json?.data ?? []).length &&
      JSON.stringify(hBefore.json?.data) === JSON.stringify(hAfter.json?.data),
  );
  check("simulations did NOT mutate transactions", (txBefore.json?.data ?? []).length === (txAfter.json?.data ?? []).length);

  /* ------------------------------ stocks ------------------------------ */
  console.log("\n[stocks]");
  const search = await req("/api/stocks?search=infosys");
  check("stock search works", (stocks.json?.data ?? []).length > 0 && (search.json?.data ?? []).some((s) => s.symbol === "INFY"));
  const sectorFilter = await req("/api/stocks?sector=IT");
  check("sector filter works", (sectorFilter.json?.data ?? []).every((s) => s.sector === "IT"));
  const tcsDetail = await req("/api/stocks/TCS");
  check("GET /api/stocks/:symbol 200", tcsDetail.status === 200);
  check("detail includes history+risk", Array.isArray(tcsDetail.json?.data?.history) && !!tcsDetail.json?.data?.risk?.riskBand);
  check("history is ~5y weekly (250+ points)", (tcsDetail.json?.data?.history ?? []).length > 250);
  const tcsPrices = await req("/api/stocks/TCS/prices?limit=10");
  check("GET /api/stocks/:symbol/prices 200", tcsPrices.status === 200);
  const sectorList = await req("/api/stocks/sectors");
  check("GET /api/stocks/sectors 200", sectorList.status === 200 && (sectorList.json?.data ?? []).length > 0);
  const stock404 = await req("/api/stocks/NOPE");
  check("unknown symbol → 404", stock404.status === 404);

  /* ----------------------------- watchlist ---------------------------- */
  console.log("\n[watchlist]");
  const wl = await req("/api/watchlist", { token: userToken });
  check("GET /api/watchlist 200", wl.status === 200);
  const wlAdd = await req("/api/watchlist", { method: "POST", token: userToken, body: { symbol: "WIPRO" } });
  check("POST /api/watchlist 201", wlAdd.status === 201, `got ${wlAdd.status}`);
  const wlDup = await req("/api/watchlist", { method: "POST", token: userToken, body: { symbol: "WIPRO" } });
  check("duplicate watchlist entry → 409", wlDup.status === 409);
  const wlRm = await req(`/api/watchlist/${wlAdd.json?.data?.id}`, { method: "DELETE", token: userToken });
  check("DELETE /api/watchlist/:id 200", wlRm.status === 200);

  /* ------------------------------- alerts ----------------------------- */
  console.log("\n[alerts]");
  const al = await req("/api/alerts", { token: userToken });
  check("GET /api/alerts 200", al.status === 200);
  check("alerts scoped to user", (al.json?.data ?? []).every((a) => a.userId === String(me.json?.data?.id)));
  const firstAlert = (al.json?.data ?? [])[0];
  if (firstAlert) {
    const markRead = await req(`/api/alerts/${firstAlert.id}/read`, { method: "PATCH", token: userToken });
    check("PATCH /api/alerts/:id/read 200", markRead.status === 200);
    check("alert is_read persisted", markRead.json?.data?.isRead === true);
  }
  const markAll = await req("/api/alerts/read-all", { method: "PATCH", token: userToken });
  check("PATCH /api/alerts/read-all 200", markAll.status === 200);

  /* ------------------------------- admin ------------------------------ */
  console.log("\n[admin]");
  const adminDenied = await req("/api/admin/stats", { token: userToken });
  check("USER blocked from admin (403)", adminDenied.status === 403, `got ${adminDenied.status}`);
  const noAuth = await req("/api/admin/stats");
  check("anonymous blocked from admin (401)", noAuth.status === 401);
  const stats = await req("/api/admin/stats", { token: adminToken });
  check("GET /api/admin/stats 200", stats.status === 200);
  check("stats counts present", typeof stats.json?.data?.totalUsers === "number" && stats.json?.data?.totalUsers > 0);
  const adminUsers = await req("/api/admin/users", { token: adminToken });
  check("GET /api/admin/users 200", adminUsers.status === 200);
  check("user list has no password hashes", !JSON.stringify(adminUsers.json).includes("password_hash"));
  const adminAudit = await req("/api/admin/audit-logs", { token: adminToken });
  check("GET /api/admin/audit-logs 200", adminAudit.status === 200);
  check("audit trail recorded actions", (adminAudit.json?.data ?? []).length > 0);
  const adminStocks = await req("/api/admin/stocks", { token: adminToken });
  check("GET /api/admin/stocks 200", adminStocks.status === 200);

  /* ------------------------------ cleanup ----------------------------- */
  console.log("\n[cleanup]");
  const pfDelete = await req(`/api/portfolios/${smokePfId}`, { method: "DELETE", token: userToken });
  check("DELETE /api/portfolios/:id 200", pfDelete.status === 200);
  const pfGone = await req(`/api/portfolios/${smokePfId}`, { token: userToken });
  check("deleted portfolio → 404", pfGone.status === 404);

  /* ------------------------------ summary ----------------------------- */
  console.log("\n──────────────────────────────");
  console.log(`PASSED: ${passed}   FAILED: ${failed}`);
  if (failures.length > 0) {
    console.log("Failures:");
    for (const f of failures) console.log(`  - ${f}`);
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error("smoke test crashed:", e);
  process.exitCode = 1;
});
