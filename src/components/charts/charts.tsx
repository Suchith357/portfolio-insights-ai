import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  Cell,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { formatCurrency } from "@/lib/format";
import type { PricePoint, SectorAllocation } from "@/types";

const CHART_COLORS = [
  "var(--color-chart-1)",
  "var(--color-chart-2)",
  "var(--color-chart-3)",
  "var(--color-chart-4)",
  "var(--color-chart-5)",
  "var(--color-chart-6)",
];

/**
 * Shared tooltip styling — dark popover surface with high-contrast text.
 * Applied to every chart in the app via this single object; labels and values
 * both use popover-foreground so nothing renders in a low-contrast grey.
 */
const tooltipStyle = {
  backgroundColor: "var(--color-popover)",
  border: "1px solid var(--color-border)",
  borderRadius: "8px",
  fontSize: "12px",
  color: "var(--color-popover-foreground)",
  boxShadow: "0 4px 16px rgba(0,0,0,0.45)",
} as const;

/** Shared label/value renderer so tooltip text never falls back to theme grey. */
const tooltipItemStyle = { color: "var(--color-popover-foreground)" } as const;

function TooltipLabel(label: unknown) {
  return <span style={tooltipItemStyle}>{String(label)}</span>;
}

export function PriceAreaChart({
  data,
  height = 280,
  valuePrefix = "₹",
}: {
  data: PricePoint[];
  height?: number;
  valuePrefix?: string;
}) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        <defs>
          <linearGradient id="priceFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--color-chart-1)" stopOpacity={0.35} />
            <stop offset="100%" stopColor="var(--color-chart-1)" stopOpacity={0} />
          </linearGradient>
        </defs>
        <XAxis
          dataKey="date"
          tick={{ fontSize: 11, fill: "var(--color-muted-foreground)" }}
          tickLine={false}
          axisLine={false}
          minTickGap={40}
          tickFormatter={(v: string) => v.slice(0, 7)}
        />
        <YAxis
          tick={{ fontSize: 11, fill: "var(--color-muted-foreground)" }}
          tickLine={false}
          axisLine={false}
          width={62}
          domain={["auto", "auto"]}
          tickFormatter={(v: number) => `${valuePrefix}${v >= 100000 ? `${(v / 100000).toFixed(1)}L` : v.toFixed(0)}`}
        />
        <Tooltip
          contentStyle={tooltipStyle}
          itemStyle={tooltipItemStyle}
          labelStyle={tooltipItemStyle}
          formatter={(v: number) => [formatCurrency(v), "Close"]}
          labelFormatter={(l: string) => l}
        />
        <Area type="monotone" dataKey="close" stroke="var(--color-chart-1)" strokeWidth={2} fill="url(#priceFill)" />
      </AreaChart>
    </ResponsiveContainer>
  );
}

export function SectorDonut({ data, height = 260 }: { data: SectorAllocation[]; height?: number }) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <PieChart>
        <Pie data={data} dataKey="value" nameKey="sector" innerRadius="55%" outerRadius="80%" paddingAngle={2}>
          {data.map((_, i) => (
            <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} stroke="var(--color-card)" />
          ))}
        </Pie>
        <Tooltip
          contentStyle={tooltipStyle}
          itemStyle={tooltipItemStyle}
          labelStyle={tooltipItemStyle}
          formatter={(v: number, n: string) => [formatCurrency(v, { compact: true }), n]}
        />
        <Legend
          verticalAlign="bottom"
          height={48}
          wrapperStyle={{ fontSize: "11px", color: "var(--color-muted-foreground)" }}
        />
      </PieChart>
    </ResponsiveContainer>
  );
}

export function AllocationBars({
  data,
  height = 260,
}: {
  data: { label: string; value: number }[];
  height?: number;
}) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} layout="vertical" margin={{ top: 4, right: 16, left: 8, bottom: 4 }}>
        <XAxis type="number" hide />
        <YAxis
          type="category"
          dataKey="label"
          width={92}
          tick={{ fontSize: 11, fill: "var(--color-muted-foreground)" }}
          tickLine={false}
          axisLine={false}
        />
        <Tooltip
          cursor={{ fill: "var(--color-accent)", opacity: 0.3 }}
          contentStyle={tooltipStyle}
          itemStyle={tooltipItemStyle}
          labelStyle={tooltipItemStyle}
          formatter={(v: number) => [`${v.toFixed(1)}%`, "Allocation"]}
        />
        <Bar dataKey="value" radius={[0, 4, 4, 0]}>
          {data.map((_, i) => (
            <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
