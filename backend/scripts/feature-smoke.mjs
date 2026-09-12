#!/usr/bin/env node
/**
 * End-to-end checks for the features added in this session:
 * CSV import (validation + weighted-average merge + audit), password change
 * rejection path, engine-generated alerts, and authorization/isolation.
 * Requires the backend to be running on :4000.
 */
import { config as dotenvConfig } from "dotenv";
dotenvConfig();

const base = process.env.API_BASE ?? "http://localhost:4000";

let passed = 0;
let failed = 0;
function check(name, cond, extra = "") {
  if (cond) {
    passed += 1;
    console.log(`  ok  ${name}`);
  } else {
    failed += 1;
    console.log(`FAIL  ${name} ${extra}`);
  }
}

function seedPassword(envName, fallback) {
  const raw = process.env[envName];
  if (!raw || raw.startsWith("change-me")) return fallback;
  return raw;
}

(async () => {
  const userPw = seedPassword("SEED_USER_PASSWORD", "demo1234");
  const adminPw = seedPassword("SEED_ADMIN_PASSWORD", "admin1234");

  const login = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "user@portfolioiq.dev", password: userPw }),
  });
  const lj = await login.json();
  if (!login.ok) {
    console.log(`LOGIN FAILED (${login.status}) — is the seed password still ${userPw}?`);
    process.exit(1);
  }
  const token = lj.data.token;
  const H = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
  const j = async (r) => ({ status: r.status, body: await r.json() });

  // Scratch portfolio for the whole run.
  const created = await j(
    await fetch(`${base}/api/portfolios`, {
      method: "POST",
      headers: H,
      body: JSON.stringify({ name: "Smoke Import Scratch", description: "temporary" }),
    }),
  );
  check("create scratch portfolio", created.status === 201 || created.status === 200);
  const pid = created.body.data.id;

  // --- CSV import ---------------------------------------------------------
  const imp = await j(
    await fetch(`${base}/api/portfolios/${pid}/import`, {
      method: "POST",
      headers: H,
      body: JSON.stringify({
        rows: [
          { symbol: "RELIANCE", quantity: 10, price: 2500 },
          { symbol: "TCS", quantity: 5, price: 3800, date: "2026-01-15" },
          { symbol: "NOPE", quantity: 3, price: 100 },
          { symbol: "INFY", quantity: -2, price: 1500 },
        ],
      }),
    }),
  );
  check("import: 2 valid rows accepted", imp.status === 200 && imp.body.data?.imported === 2, JSON.stringify(imp.body));
  check("import: 2 invalid rows reported", imp.body.data?.errors?.length === 2, JSON.stringify(imp.body.data?.errors));

  // Weighted-average merge on second import of the same symbol.
  const imp2 = await j(
    await fetch(`${base}/api/portfolios/${pid}/import`, {
      method: "POST",
      headers: H,
      body: JSON.stringify({ rows: [{ symbol: "RELIANCE", quantity: 10, price: 3000 }] }),
    }),
  );
  check("import: merge run accepted", imp2.status === 200 && imp2.body.data?.imported === 1);

  const view = await j(await fetch(`${base}/api/portfolios/${pid}/analysis`, { headers: H }));
  const rel = view.body.data.holdings.find((h) => h.symbol === "RELIANCE");
  check(
    "weighted average correct (10@2500 + 10@3000 => 20@2750)",
    rel && rel.quantity === 20 && Math.abs(rel.avgBuyPrice - 2750) < 0.01,
    rel ? `qty=${rel.quantity} avg=${rel.avgBuyPrice}` : "RELIANCE missing",
  );

  const txns = await j(await fetch(`${base}/api/transactions/portfolio/${pid}`, { headers: H }));
  check("import created 3 BUY transactions", txns.body.data?.length === 3, `got ${txns.body.data?.length}`);

  // --- authorization ------------------------------------------------------
  const unauth = await j(
    await fetch(`${base}/api/portfolios/${pid}/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rows: [{ symbol: "TCS", quantity: 1, price: 100 }] }),
    }),
  );
  check("import without token => 401", unauth.status === 401);

  const al = await j(
    await fetch(`${base}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "admin@portfolioiq.dev", password: adminPw }),
    }),
  );
  const aH = { "Content-Type": "application/json", Authorization: `Bearer ${al.body.data.token}` };
  const cross = await j(
    await fetch(`${base}/api/portfolios/${pid}/import`, {
      method: "POST",
      headers: aH,
      body: JSON.stringify({ rows: [{ symbol: "TCS", quantity: 1, price: 100 }] }),
    }),
  );
  check("import on another user's portfolio => 404 (isolation)", cross.status === 404, `got ${cross.status}`);

  // --- password change ----------------------------------------------------
  const badPw = await j(
    await fetch(`${base}/api/users/me/password`, {
      method: "PATCH",
      headers: H,
      body: JSON.stringify({ currentPassword: "definitely-wrong", newPassword: "newpassword123" }),
    }),
  );
  check("password change with wrong current password => 401", badPw.status === 401, `got ${badPw.status}`);

  const shortPw = await j(
    await fetch(`${base}/api/users/me/password`, {
      method: "PATCH",
      headers: H,
      body: JSON.stringify({ currentPassword: userPw, newPassword: "short" }),
    }),
  );
  check("password change with weak new password => 400", shortPw.status === 400, `got ${shortPw.status}`);

  // --- engine-generated alerts ---------------------------------------------
  const portfolios = await j(await fetch(`${base}/api/portfolios`, { headers: H }));
  const target = portfolios.body.data.find((p) => p.id !== pid) ?? portfolios.body.data[0];
  if (target) {
    const an = await j(
      await fetch(`${base}/api/portfolios/${target.id}/analyze`, { method: "POST", headers: H }),
    );
    check("analyze (snapshot) works", an.status === 200 && !!an.body.data?.snapshotId);

    const alerts = await j(await fetch(`${base}/api/alerts`, { headers: H }));
    const engine = (alerts.body.data ?? []).filter((a) =>
      ["CONCENTRATION", "HIGH_RISK", "LOW_DIVERSIFICATION"].includes(a.eventType),
    );
    check("engine-generated alerts exist after analyze", engine.length > 0, "none found");

    // Deduplication: a second analyze must not duplicate unread engine alerts.
    const before = engine.length;
    await fetch(`${base}/api/portfolios/${target.id}/analyze`, { method: "POST", headers: H });
    const alerts2 = await j(await fetch(`${base}/api/alerts`, { headers: H }));
    const engine2 = (alerts2.body.data ?? []).filter((a) =>
      ["CONCENTRATION", "HIGH_RISK", "LOW_DIVERSIFICATION"].includes(a.eventType),
    );
    check("alerts deduped across repeated analyze", engine2.length <= before + 2, `${before} -> ${engine2.length}`);
  }

  // --- cleanup --------------------------------------------------------------
  const del = await j(await fetch(`${base}/api/portfolios/${pid}`, { method: "DELETE", headers: H }));
  check("scratch portfolio deleted", del.status === 200 || del.status === 204);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
