/**
 * Generic CSV parsing for portfolio import.
 *
 * Parses text into typed rows. Column names are mapped flexibly so exports
 * from common spreadsheets work without configuration. The BACKEND remains
 * the source of validation truth; this module exists so the user can preview
 * and confirm rows before anything is written.
 */

export interface ParsedCsvRow {
  rowNumber: number;
  symbol?: string;
  quantity?: number;
  price?: number;
  date?: string;
  problem?: string;
}

/** Column aliases — first match wins. */
const SYMBOL_KEYS = ["symbol", "ticker", "stock", "scrip", "security"];
const QTY_KEYS = ["quantity", "qty", "shares", "units"];
const PRICE_KEYS = ["average_price", "avg_price", "buy_price", "purchase_price", "price", "avg buy price", "average buy price"];
const DATE_KEYS = ["date", "purchase_date", "buy_date", "trade_date"];

const NUMERIC_CLEAN = /[,\s₹]/g;

function findKey(headers: string[], candidates: string[]): string | undefined {
  const lowered = headers.map((h) => h.trim().toLowerCase());
  for (const c of candidates) {
    const idx = lowered.indexOf(c);
    if (idx >= 0) return headers[idx];
  }
  // Partial fallback: header contains the candidate (e.g. "avg. price").
  for (const c of candidates) {
    const idx = lowered.findIndex((h) => h.includes(c));
    if (idx >= 0) return headers[idx];
  }
  return undefined;
}
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "\"") {
      if (inQuotes && line[i + 1] === "\"") {
        cur += "\"";
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if ((ch === "," || ch === ";" || ch === "\t") && !inQuotes) {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

/**
 * Parses CSV text into preview rows. Requires at minimum a symbol column and
 * one of quantity/price. Rows that cannot be understood are returned with a
 * `problem` so the user can see exactly what will be skipped.
 */
export function parseHoldingsCsv(text: string): ParsedCsvRow[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return [];

  const headers = splitCsvLine(lines[0] ?? "").map((h) => h.replace(/^\"|\"$/g, ""));
  const symbolKey = findKey(headers, SYMBOL_KEYS);
  const qtyKey = findKey(headers, QTY_KEYS);
  const priceKey = findKey(headers, PRICE_KEYS);
  const dateKey = findKey(headers, DATE_KEYS);

  if (!symbolKey || !qtyKey || !priceKey) {
    return [
      {
        rowNumber: 0,
        problem:
          "Could not find the required columns. The file needs at least a symbol/ticker column plus quantity and price columns (e.g. symbol, quantity, average_price).",
      },
    ];
  }

  const idx = new Map<string, number>();
  headers.forEach((h, i) => idx.set(h, i));

  return lines.slice(1).map((line, i) => {
    const cells = splitCsvLine(line);
    const get = (key: string | undefined) => (key === undefined ? undefined : cells[idx.get(key) ?? -1]);

    const symbol = get(symbolKey)?.toUpperCase();
    if (!symbol) {
      return { rowNumber: i + 2, problem: "Missing symbol." };
    }
    const rawQty = get(qtyKey);
    const quantity = rawQty === undefined ? NaN : Number(rawQty.replace(NUMERIC_CLEAN, ""));
    if (!Number.isFinite(quantity) || quantity <= 0) {
      return { rowNumber: i + 2, symbol, problem: `Quantity “${rawQty ?? ""}” is not a number greater than 0.` };
    }
    const rawPrice = get(priceKey);
    const price = rawPrice === undefined ? NaN : Number(rawPrice.replace(NUMERIC_CLEAN, ""));
    if (!Number.isFinite(price) || price <= 0) {
      return { rowNumber: i + 2, symbol, problem: `Price “${rawPrice ?? ""}” is not a number greater than 0.` };
    }
    const rawDate = get(dateKey);
    if (rawDate) {
      const parsed = new Date(rawDate);
      if (Number.isNaN(parsed.getTime())) {
        return { rowNumber: i + 2, symbol, quantity, price, problem: `Date “${rawDate}” is not a valid date.` };
      }
      return { rowNumber: i + 2, symbol, quantity, price, date: parsed.toISOString() };
    }
    return { rowNumber: i + 2, symbol, quantity, price };
  });
}
