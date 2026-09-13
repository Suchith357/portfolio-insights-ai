export function formatCurrency(value: number, opts: { compact?: boolean } = {}) {
  if (opts.compact) {
    const abs = Math.abs(value);
    if (abs >= 1_00_00_000) return `₹${(value / 1_00_00_000).toFixed(2)} Cr`;
    if (abs >= 1_00_000) return `₹${(value / 1_00_000).toFixed(2)} L`;
    if (abs >= 1_000) return `₹${(value / 1_000).toFixed(1)}K`;
  }
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 2,
  }).format(value);
}

export function formatNumber(value: number, digits = 2) {
  return new Intl.NumberFormat("en-IN", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);
}

export function formatPct(value: number, digits = 2) {
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(digits)}%`;
}

export function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

export function formatDateTime(iso: string) {
  return new Date(iso).toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function initials(name: string) {
  return name
    .split(" ")
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

/**
 * Renders a nullable financial figure without ever substituting zero for a
 * missing value — unavailable data shows as "N/A".
 */
export function formatCurrencyOrNull(value: number | null | undefined, opts: { compact?: boolean } = {}) {
  return value === null || value === undefined ? "N/A" : formatCurrency(value, opts);
}

export function formatPctOrNull(value: number | null | undefined, digits = 2) {
  return value === null || value === undefined ? "N/A" : formatPct(value, digits);
}

export function formatNumberOrNull(value: number | null | undefined, digits = 2) {
  return value === null || value === undefined ? "N/A" : formatNumber(value, digits);
}

/** Human-readable market-cap in ₹ crore; N/A when unknown. */
export function formatMarketCap(cr: number | null | undefined) {
  return cr === null || cr === undefined ? "N/A" : `₹${formatNumber(cr, 0)} Cr`;
}

/** Relative-age description of a data timestamp for freshness badges. */
export function dataAge(iso: string | null | undefined): { label: string; stale: boolean; level: "current" | "recent" | "stale" | "none" } {
  if (!iso) return { label: "No data yet", stale: true, level: "none" };
  const ms = Date.now() - new Date(iso).getTime();
  const hours = ms / 3_600_000;
  const label =
    hours < 1
      ? "just now"
      : hours < 24
        ? `${Math.floor(hours)}h ago`
        : `${Math.floor(hours / 24)}d ago`;
  const level: "current" | "recent" | "stale" | "none" = hours < 2 ? "current" : hours < 26 ? "recent" : "stale";
  return { label, stale: level !== "current", level };
}
