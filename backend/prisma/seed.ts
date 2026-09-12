/**
 * Safe, idempotent seed for the EXISTING `portfolioiq` PostgreSQL database.
 *
 * - Never drops, truncates or resets anything.
 * - Upserts demo accounts (passwords from env), stocks and weekly prices.
 * - Creates demo portfolios/holdings/transactions/watchlist only when the user
 *   has none, so re-running never duplicates rows.
 *
 * Run: npm run db:seed   (from backend/)
 */
import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient({
  log: process.env["NODE_ENV"] === "development" ? ["warn", "error"] : ["error"],
});

/**
 * Demo-account passwords.
 *
 * A real SEED_USER_PASSWORD / SEED_ADMIN_PASSWORD in .env always wins. If the
 * var is unset — or still holds the .env.example placeholder — the seed falls
 * back to the demo credentials advertised on the login page (demo1234 /
 * admin1234) so the seeded accounts actually match the UI contract.
 */
const PLACEHOLDER_PASSWORDS = new Set(["change-me-user", "change-me-admin"]);

function seedPassword(envKey: string, fallback: string): string {
  const raw = process.env[envKey]?.trim();
  return raw && raw.length > 0 && !PLACEHOLDER_PASSWORDS.has(raw) ? raw : fallback;
}

const SEED_USER_PASSWORD = seedPassword("SEED_USER_PASSWORD", "demo1234");
const SEED_ADMIN_PASSWORD = seedPassword("SEED_ADMIN_PASSWORD", "admin1234");
const BCRYPT_ROUNDS = Number(process.env["BCRYPT_ROUNDS"] ?? 10);

const DEMO_EMAIL = "user@portfolioiq.dev";
const ADMIN_EMAIL = "admin@portfolioiq.dev";
const EXCHANGE = "NSE";

interface StockSeed {
  symbol: string;
  name: string;
  sector: string;
  industry: string;
  marketCap: number;
  peRatio: number;
  dividendYield: number;
  basePrice: number;
  vol: number;
  drift: number;
  description: string;
}

const STOCK_SEEDS: StockSeed[] = [
  { symbol: "RELIANCE", name: "Reliance Industries", sector: "Energy", industry: "Oil & Gas", marketCap: 1800000, peRatio: 24.5, dividendYield: 0.35, basePrice: 152, vol: 0.23, drift: 0.1, description: "Diversified Indian conglomerate with major energy and consumer businesses." },
  { symbol: "TCS", name: "Tata Consultancy Services", sector: "IT", industry: "IT Services", marketCap: 1300000, peRatio: 28.2, dividendYield: 1.2, basePrice: 232, vol: 0.2, drift: 0.09, description: "Major Indian information technology services company." },
  { symbol: "INFY", name: "Infosys", sector: "IT", industry: "IT Services", marketCap: 750000, peRatio: 25.8, dividendYield: 2.1, basePrice: 152, vol: 0.24, drift: 0.08, description: "Indian multinational information technology services company." },
  { symbol: "HDFCBANK", name: "HDFC Bank", sector: "Banking", industry: "Private Bank", marketCap: 1150000, peRatio: 19.4, dividendYield: 1.1, basePrice: 168, vol: 0.19, drift: 0.07, description: "One of India's largest private sector banks." },
  { symbol: "ICICIBANK", name: "ICICI Bank", sector: "Banking", industry: "Private Bank", marketCap: 820000, peRatio: 18.1, dividendYield: 0.9, basePrice: 98, vol: 0.21, drift: 0.13, description: "Leading Indian private sector bank with retail and corporate franchises." },
  { symbol: "SBIN", name: "State Bank of India", sector: "Banking", industry: "PSU Bank", marketCap: 690000, peRatio: 11.2, dividendYield: 1.6, basePrice: 68, vol: 0.28, drift: 0.12, description: "India's largest public sector bank." },
  { symbol: "ITC", name: "ITC Limited", sector: "FMCG", industry: "Consumer Goods", marketCap: 520000, peRatio: 26.4, dividendYield: 3.2, basePrice: 42, vol: 0.17, drift: 0.08, description: "Diversified FMCG, hotels and tobacco company." },
  { symbol: "HINDUNILVR", name: "Hindustan Unilever", sector: "FMCG", industry: "Consumer Goods", marketCap: 570000, peRatio: 54.1, dividendYield: 1.8, basePrice: 238, vol: 0.16, drift: 0.02, description: "India's largest fast-moving consumer goods company." },
  { symbol: "SUNPHARMA", name: "Sun Pharmaceutical", sector: "Pharma", industry: "Pharmaceuticals", marketCap: 410000, peRatio: 36.2, dividendYield: 0.8, basePrice: 142, vol: 0.24, drift: 0.15, description: "India's largest pharmaceutical company by market value." },
  { symbol: "DRREDDY", name: "Dr. Reddy's Laboratories", sector: "Pharma", industry: "Pharmaceuticals", marketCap: 105000, peRatio: 21.5, dividendYield: 0.9, basePrice: 128, vol: 0.25, drift: 0.07, description: "Global pharmaceutical company headquartered in Hyderabad." },
  { symbol: "TATAMOTORS", name: "Tata Motors", sector: "Auto", industry: "Automobiles", marketCap: 350000, peRatio: 12.3, dividendYield: 0.6, basePrice: 72, vol: 0.36, drift: 0.16, description: "Indian automotive manufacturer with global commercial vehicle operations." },
  { symbol: "M&M", name: "Mahindra & Mahindra", sector: "Auto", industry: "Automobiles", marketCap: 355000, peRatio: 24.8, dividendYield: 0.7, basePrice: 68, vol: 0.29, drift: 0.18, description: "Utility vehicles, tractors and diversified engineering group." },
  { symbol: "TATASTEEL", name: "Tata Steel", sector: "Metals", industry: "Steel", marketCap: 185000, peRatio: 17.9, dividendYield: 2.4, basePrice: 152, vol: 0.34, drift: 0.05, description: "Global steel producer with major Indian and European operations." },
  { symbol: "JSWSTEEL", name: "JSW Steel", sector: "Metals", industry: "Steel", marketCap: 220000, peRatio: 42.3, dividendYield: 0.5, basePrice: 92, vol: 0.31, drift: 0.07, description: "One of India's leading integrated steel manufacturers." },
  { symbol: "BHARTIARTL", name: "Bharti Airtel", sector: "Telecom", industry: "Telecom Services", marketCap: 890000, peRatio: 44.6, dividendYield: 0.8, basePrice: 145, vol: 0.25, drift: 0.19, description: "Leading Indian telecommunications operator." },
  { symbol: "LT", name: "Larsen & Toubro", sector: "Infrastructure", industry: "Construction", marketCap: 490000, peRatio: 34.1, dividendYield: 0.9, basePrice: 148, vol: 0.22, drift: 0.16, description: "Indian multinational in engineering, procurement and construction." },
  { symbol: "ADANIPORTS", name: "Adani Ports & SEZ", sector: "Infrastructure", industry: "Ports", marketCap: 300000, peRatio: 28.4, dividendYield: 0.4, basePrice: 138, vol: 0.4, drift: 0.14, description: "India's largest private port operator." },
  { symbol: "ULTRACEMCO", name: "UltraTech Cement", sector: "Infrastructure", industry: "Cement", marketCap: 315000, peRatio: 44.2, dividendYield: 0.4, basePrice: 98, vol: 0.21, drift: 0.12, description: "India's largest cement manufacturer." },
  { symbol: "MARUTI", name: "Maruti Suzuki India", sector: "Auto", industry: "Automobiles", marketCap: 355000, peRatio: 26.9, dividendYield: 1.3, basePrice: 92, vol: 0.24, drift: 0.09, description: "India's largest passenger vehicle manufacturer." },
  { symbol: "KOTAKBANK", name: "Kotak Mahindra Bank", sector: "Banking", industry: "Private Bank", marketCap: 350000, peRatio: 18.6, dividendYield: 0.4, basePrice: 98, vol: 0.22, drift: 0.03, description: "Private sector bank with retail, corporate and investment banking." },
  { symbol: "BAJFINANCE", name: "Bajaj Finance", sector: "Banking", industry: "NBFC", marketCap: 430000, peRatio: 30.2, dividendYield: 0.5, basePrice: 72, vol: 0.31, drift: 0.1, description: "Diversified non-banking finance company." },
  { symbol: "CIPLA", name: "Cipla", sector: "Pharma", industry: "Pharmaceuticals", marketCap: 120000, peRatio: 23.8, dividendYield: 0.9, basePrice: 152, vol: 0.22, drift: 0.11, description: "Indian pharmaceutical company with global respiratory franchise." },
  { symbol: "ONGC", name: "Oil & Natural Gas Corp", sector: "Energy", industry: "Oil & Gas", marketCap: 335000, peRatio: 8.4, dividendYield: 4.2, basePrice: 32, vol: 0.3, drift: 0.06, description: "India's largest oil and gas exploration and production company." },
  { symbol: "NTPC", name: "NTPC Limited", sector: "Energy", industry: "Power", marketCap: 345000, peRatio: 15.6, dividendYield: 2.2, basePrice: 35, vol: 0.26, drift: 0.14, description: "India's largest power generator." },
  { symbol: "HINDALCO", name: "Hindalco Industries", sector: "Metals", industry: "Aluminium", marketCap: 145000, peRatio: 11.8, dividendYield: 0.5, basePrice: 65, vol: 0.33, drift: 0.09, description: "Aluminium and copper producer with global subsidiary Novelis." },
  { symbol: "WIPRO", name: "Wipro Limited", sector: "IT", industry: "IT Services", marketCap: 265000, peRatio: 22.1, dividendYield: 0.4, basePrice: 51, vol: 0.27, drift: 0.04, description: "Global information technology, consulting and business process services company." },
  { symbol: "HCLTECH", name: "HCL Technologies", sector: "IT", industry: "IT Services", marketCap: 440000, peRatio: 26.3, dividendYield: 1.1, basePrice: 162, vol: 0.23, drift: 0.11, description: "Global IT services company headquartered in Noida." },
  { symbol: "NESTLEIND", name: "Nestle India", sector: "FMCG", industry: "Consumer Goods", marketCap: 225000, peRatio: 68.4, dividendYield: 1.1, basePrice: 232, vol: 0.15, drift: 0.05, description: "Indian subsidiary of Nestle with leading food and beverage brands." },
  { symbol: "DLF", name: "DLF Limited", sector: "Infrastructure", industry: "Real Estate", marketCap: 195000, peRatio: 88.2, dividendYield: 0.6, basePrice: 78, vol: 0.35, drift: 0.13, description: "India's largest listed real estate developer." },
  { symbol: "IDEA", name: "Vodafone Idea", sector: "Telecom", industry: "Telecom Services", marketCap: 98000, peRatio: 0, dividendYield: 0, basePrice: 14, vol: 0.62, drift: -0.12, description: "Indian telecom operator formed by the Vodafone-Idea merger." },
];

function mulberry32(seed: number) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash(str: string) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
    h >>>= 0;
  }
  return h >>> 0;
}

/** Weekly closes ending at the latest existing date or the coming week. */
function syntheticWeeklyCloses(symbol: string, basePrice: number, vol: number, drift: number, endDate: Date, weeks = 261) {
  const rand = mulberry32(hash(symbol));
  const dt = 1 / 52;
  const points: { date: Date; close: number }[] = [];
  let price = basePrice;
  for (let i = 0; i < weeks; i++) {
    const d = new Date(endDate);
    d.setUTCDate(d.getUTCDate() - i * 7);
    points.push({ date: d, close: Number(price.toFixed(2)) });
    const shock = (rand() + rand() + rand() + rand() - 2) * 0.9;
    const step = Math.exp((drift - (vol * vol) / 2) * dt + vol * Math.sqrt(dt) * shock);
    price = Math.max(price / step, 0.5);
  }
  return points.reverse();
}

function toWeekDate(date: Date): Date {
  const d = new Date(date);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

async function seedUsers() {
  const userHash = await bcrypt.hash(SEED_USER_PASSWORD, BCRYPT_ROUNDS);
  const adminHash = await bcrypt.hash(SEED_ADMIN_PASSWORD, BCRYPT_ROUNDS);

  await prisma.users.upsert({
    where: { email: DEMO_EMAIL },
    update: {},
    create: { name: "Demo User", email: DEMO_EMAIL, password_hash: userHash, role: "USER" },
  });
  const admin = await prisma.users.upsert({
    where: { email: ADMIN_EMAIL },
    update: {},
    create: { name: "Admin User", email: ADMIN_EMAIL, password_hash: adminHash, role: "ADMIN" },
  });

  // The two DEMO accounts always honour the env-configured passwords: if the
  // stored hash no longer verifies (legacy plaintext or an older env value),
  // re-hash it. Real user rows are never touched.
  const demoAccounts = await prisma.users.findMany({
    where: { email: { in: [DEMO_EMAIL, ADMIN_EMAIL] } },
    select: { user_id: true, email: true, password_hash: true },
  });
  for (const acc of demoAccounts) {
    const expected = acc.email === ADMIN_EMAIL ? SEED_ADMIN_PASSWORD : SEED_USER_PASSWORD;
    const matches = /^\$2[aby]\$/.test(acc.password_hash)
      ? await bcrypt.compare(expected, acc.password_hash)
      : false;
    if (!matches) {
      await prisma.users.update({
        where: { user_id: acc.user_id },
        data: { password_hash: acc.email === ADMIN_EMAIL ? adminHash : userHash },
      });
      console.log(`[seed] reset password hash for demo account ${acc.email} to match SEED_*_PASSWORD`);
    }
  }

  console.log(`[seed] users ready (${DEMO_EMAIL}, ${ADMIN_EMAIL})`);
  return admin;
}

async function seedStocksAndPrices() {
  const latestRow = await prisma.stock_prices.aggregate({ _max: { price_date: true } });
  const endDate = toWeekDate(latestRow._max.price_date ?? new Date());
  let createdPrices = 0;

  for (const seed of STOCK_SEEDS) {
    const stock = await prisma.stocks.upsert({
      where: { symbol_exchange: { symbol: seed.symbol, exchange: EXCHANGE } },
      update: {},
      create: {
        symbol: seed.symbol,
        company_name: seed.name,
        sector: seed.sector,
        industry: seed.industry,
        exchange: EXCHANGE,
        description: seed.description,
        market_cap: seed.marketCap,
        pe_ratio: seed.peRatio,
        dividend_yield: seed.dividendYield,
        is_active: true,
      },
    });

    const existing = await prisma.stock_prices.findMany({
      where: { stock_id: stock.stock_id },
      select: { price_date: true },
    });
    const have = new Set(existing.map((r) => r.price_date.toISOString().slice(0, 10)));

    const closes = syntheticWeeklyCloses(seed.symbol, seed.basePrice, seed.vol, seed.drift, endDate);
    const missing = closes.filter((p) => !have.has(p.date.toISOString().slice(0, 10)));

    if (missing.length > 0) {
      const data = missing.map((p) => {
        const open = Number((p.close * (0.98 + mulberry32(hash(seed.symbol + p.date.toISOString()))()) * 0.04).toFixed(2));
        const high = Number(Math.max(open, p.close).toFixed(2));
        const low = Number(Math.min(open, p.close).toFixed(2));
        return {
          stock_id: stock.stock_id,
          price_date: p.date,
          open_price: open,
          high_price: high,
          low_price: low,
          close_price: p.close,
          volume: Math.floor(500_000 + mulberry32(hash(seed.symbol + "v" + p.date.toISOString()))() * 9_500_000),
        };
      });
      await prisma.stock_prices.createMany({ data });
      createdPrices += data.length;
    }
  }

  console.log(`[seed] ${STOCK_SEEDS.length} stocks ready; ${createdPrices} price rows added`);
}

/** Demo portfolio content only when the user has no portfolios yet. */
async function seedDemoContent() {
  const user = await prisma.users.findUnique({ where: { email: DEMO_EMAIL } });
  if (!user) return;

  const existingPortfolios = await prisma.portfolios.count({ where: { user_id: user.user_id } });
  if (existingPortfolios > 0) {
    console.log(`[seed] demo user already has ${existingPortfolios} portfolios — skipping demo content`);
    return;
  }

  const stockBySymbol = new Map(
    (await prisma.stocks.findMany({ where: { symbol: { in: STOCK_SEEDS.map((s) => s.symbol) } } })).map((s) => [s.symbol, s]),
  );

  const longTerm = await prisma.portfolios.create({
    data: { user_id: user.user_id, name: "Long Term Portfolio", description: "Diversified long-term investment portfolio" },
  });
  const growth = await prisma.portfolios.create({
    data: { user_id: user.user_id, name: "Growth Portfolio", description: "Growth-focused portfolio with higher risk exposure" },
  });

  const lots: Array<{ portfolioId: number; symbol: string; qty: number; price: number; monthsAgo: number }> = [
    { portfolioId: longTerm.portfolio_id, symbol: "TCS", qty: 35, price: 3500, monthsAgo: 14 },
    { portfolioId: longTerm.portfolio_id, symbol: "HDFCBANK", qty: 30, price: 1550, monthsAgo: 13 },
    { portfolioId: longTerm.portfolio_id, symbol: "RELIANCE", qty: 20, price: 2400, monthsAgo: 11 },
    { portfolioId: longTerm.portfolio_id, symbol: "ITC", qty: 40, price: 420, monthsAgo: 9 },
    { portfolioId: longTerm.portfolio_id, symbol: "SUNPHARMA", qty: 15, price: 1450, monthsAgo: 7 },
    { portfolioId: growth.portfolio_id, symbol: "INFY", qty: 30, price: 1500, monthsAgo: 12 },
    { portfolioId: growth.portfolio_id, symbol: "TATAMOTORS", qty: 35, price: 1100, monthsAgo: 10 },
    { portfolioId: growth.portfolio_id, symbol: "MARUTI", qty: 20, price: 9500, monthsAgo: 8 },
    { portfolioId: growth.portfolio_id, symbol: "JSWSTEEL", qty: 50, price: 650, monthsAgo: 6 },
    { portfolioId: growth.portfolio_id, symbol: "BHARTIARTL", qty: 15, price: 2800, monthsAgo: 5 },
  ];

  for (const lot of lots) {
    const stock = stockBySymbol.get(lot.symbol);
    if (!stock) continue;
    const when = new Date();
    when.setMonth(when.getMonth() - lot.monthsAgo);
    await prisma.transactions.create({
      data: {
        portfolio_id: lot.portfolioId,
        stock_id: stock.stock_id,
        transaction_type: "BUY",
        quantity: lot.qty,
        price: lot.price,
        transaction_date: when,
      },
    });
    await prisma.holdings.upsert({
      where: { portfolio_id_stock_id: { portfolio_id: lot.portfolioId, stock_id: stock.stock_id } },
      update: { quantity: { increment: lot.qty }, average_buy_price: lot.price },
      create: { portfolio_id: lot.portfolioId, stock_id: stock.stock_id, quantity: lot.qty, average_buy_price: lot.price },
    });
  }

  const watchSymbols = ["TCS", "INFY", "KOTAKBANK", "HINDUNILVR", "M&M", "LT"];
  for (const symbol of watchSymbols) {
    const stock = stockBySymbol.get(symbol);
    if (!stock) continue;
    await prisma.watchlists.upsert({
      where: { user_id_stock_id: { user_id: user.user_id, stock_id: stock.stock_id } },
      update: {},
      create: { user_id: user.user_id, stock_id: stock.stock_id },
    });
  }

  await prisma.alerts.createMany({
    data: [
      {
        user_id: user.user_id,
        portfolio_id: longTerm.portfolio_id,
        alert_type: "RISK",
        severity: "HIGH",
        title: "High Portfolio Risk",
        message: "Your Long Term Portfolio currently has elevated risk exposure.",
      },
      {
        user_id: user.user_id,
        portfolio_id: longTerm.portfolio_id,
        alert_type: "DIVERSIFICATION",
        severity: "MEDIUM",
        title: "Sector Concentration",
        message: "Your portfolio has relatively high exposure to the IT sector.",
      },
      {
        user_id: user.user_id,
        portfolio_id: growth.portfolio_id,
        stock_id: stockBySymbol.get("INFY")?.stock_id ?? null,
        alert_type: "VOLATILITY",
        severity: "MEDIUM",
        title: "Increased Volatility",
        message: "Infosys has shown increased historical price volatility.",
      },
      {
        user_id: user.user_id,
        portfolio_id: growth.portfolio_id,
        alert_type: "PERFORMANCE",
        severity: "LOW",
        title: "Positive Performance",
        message: "Your Growth Portfolio has shown positive recent performance.",
      },
      {
        user_id: user.user_id,
        stock_id: stockBySymbol.get("M&M")?.stock_id ?? null,
        alert_type: "WATCHLIST",
        severity: "LOW",
        title: "Watchlist Stock",
        message: "Mahindra & Mahindra is currently present on your watchlist.",
      },
    ],
  });

  console.log("[seed] demo portfolios, holdings, transactions, watchlist and alerts created");
}

async function seedAuditBaseline(userId: number) {
  const count = await prisma.audit_logs.count();
  if (count > 0) return;
  await prisma.audit_logs.createMany({
    data: [
      { user_id: userId, action: "LOGIN", entity_type: "USER", entity_id: userId, details: "Demo user logged into PortfolioIQ." },
      { user_id: userId, action: "ANALYSIS", entity_type: "PORTFOLIO", entity_id: null, details: "Portfolio risk and diversification analysis completed." },
    ],
  });
  console.log("[seed] baseline audit entries created");
}

async function main() {
  console.log("[seed] starting safe seed of the existing portfolioiq database");
  const admin = await seedUsers();
  const user = await prisma.users.findUnique({ where: { email: DEMO_EMAIL } });
  if (user) await seedAuditBaseline(user.user_id);
  await seedStocksAndPrices();
  await seedDemoContent();
  void admin;
  console.log("[seed] done");
}

main()
  .catch((e) => {
    console.error("[seed] failed:", e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
