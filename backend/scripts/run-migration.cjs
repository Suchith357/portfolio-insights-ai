// Statement-by-statement SQL migration runner (dollar-quote aware).
// Usage: node scripts/run-migration.js prisma/sql/<file>.sql
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();

/** Split a SQL script into statements, respecting '' strings and $tag$ blocks. */
function splitSql(sql) {
  const stmts = [];
  let cur = "";
  let inString = false;
  let dollarTag = null;
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    const rest = sql.slice(i);
    if (dollarTag) {
      if (rest.startsWith(dollarTag)) {
        cur += dollarTag;
        i += dollarTag.length;
        dollarTag = null;
        continue;
      }
      cur += ch;
      i += 1;
      continue;
    }
    if (ch === "$") {
      const m = /^\$([A-Za-z_]*)\$/.exec(rest);
      if (m) {
        dollarTag = m[0];
        cur += dollarTag;
        i += dollarTag.length;
        continue;
      }
    }
    if (ch === "'") {
      inString = !inString;
      cur += ch;
      i += 1;
      continue;
    }
    if (!inString && ch === "-" && sql[i + 1] === "-") {
      while (i < sql.length && sql[i] !== "\n") i += 1;
      continue;
    }
    if (!inString && ch === ";") {
      if (cur.trim()) stmts.push(cur.trim());
      cur = "";
      i += 1;
      continue;
    }
    cur += ch;
    i += 1;
  }
  if (cur.trim()) stmts.push(cur.trim());
  return stmts.filter((s) => !/^(BEGIN|COMMIT)$/i.test(s));
}

async function main() {
  const file = process.argv[2];
  if (!file) throw new Error("Usage: node scripts/run-migration.js <sql-file>");
  const sql = fs.readFileSync(path.resolve(file), "utf8");
  const stmts = splitSql(sql);
  console.log(`[migration] executing ${stmts.length} statements from ${file}`);
  for (const [i, s] of stmts.entries()) {
    try {
      await prisma.$executeRawUnsafe(s);
    } catch (err) {
      console.error(`[migration] FAILED at statement ${i}: ${err.message.slice(0, 300)}`);
      console.error(`[migration] SQL was: ${s.slice(0, 200)}`);
      process.exit(1);
    }
  }
  console.log("[migration] done");
}

main()
  .catch((e) => {
    console.error("[migration] fatal:", e.message);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
