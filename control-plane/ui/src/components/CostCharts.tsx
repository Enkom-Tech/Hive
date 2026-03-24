import { useMemo } from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
  BarChart,
  Bar,
  Legend,
} from "recharts";
import type { CostSeriesPoint, CostByModel } from "@hive/shared";
import { formatCents, formatTokens } from "../lib/utils";
import { ChartCard } from "./ActivityCharts";

const CHART_COLORS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
];

function getResolvedChartColors(): string[] {
  if (typeof document === "undefined") {
    return ["#64748b", "#0ea5e9", "#8b5cf6", "#f59e0b", "#ef4444"];
  }
  const root = document.documentElement;
  return [1, 2, 3, 4, 5].map(
    (i) =>
      getComputedStyle(root).getPropertyValue(`--chart-${i}`).trim() ||
      "#64748b",
  );
}

export function CostOverTimeChart({ series }: { series: CostSeriesPoint[] }) {
  const colors = useMemo(() => getResolvedChartColors(), []);

  if (series.length === 0) {
    return (
      <ChartCard title="Cost over time" subtitle="Daily or weekly rollup">
        <p className="text-xs text-muted-foreground">No cost data in this range.</p>
      </ChartCard>
    );
  }

  return (
    <ChartCard title="Cost over time" subtitle="Daily or weekly rollup">
      <div className="h-[240px] w-full">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart
            data={series}
            margin={{ top: 8, right: 8, left: 0, bottom: 0 }}
          >
            <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
            <XAxis
              dataKey="date"
              tick={{ fontSize: 10 }}
              tickFormatter={(v) => {
                const d = new Date(v + "T12:00:00");
                return `${d.getMonth() + 1}/${d.getDate()}`;
              }}
            />
            <YAxis
              tick={{ fontSize: 10 }}
              tickFormatter={(v) => `$${(v / 100).toFixed(2)}`}
            />
            <Tooltip
              content={({ active, payload }) => {
                if (!active || !payload?.length || !payload[0].payload) return null;
                const p = payload[0].payload as CostSeriesPoint;
                return (
                  <div className="rounded-md border border-border bg-card px-3 py-2 text-sm shadow-md">
                    <p className="font-medium">{p.date}</p>
                    <p>{formatCents(p.costCents)}</p>
                    <p className="text-muted-foreground text-xs">
                      In {formatTokens(p.inputTokens)} / Out {formatTokens(p.outputTokens)} tok
                    </p>
                  </div>
                );
              }}
            />
            <Line
              type="monotone"
              dataKey="costCents"
              stroke={colors[0]}
              strokeWidth={2}
              dot={{ r: 2 }}
              name="Cost"
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </ChartCard>
  );
}

const TOP_MODELS = 10;

export function CostByModelChart({ byModel }: { byModel: CostByModel[] }) {
  const colors = useMemo(() => getResolvedChartColors(), []);

  const pieData = useMemo(() => {
    const sorted = [...byModel].sort((a, b) => b.costCents - a.costCents);
    const top = sorted.slice(0, TOP_MODELS);
    return top.map((row) => ({
      name: row.model,
      value: row.costCents,
      fullLabel: `${row.model} (${row.provider})`,
    }));
  }, [byModel]);

  if (byModel.length === 0) {
    return (
      <ChartCard title="Cost by model" subtitle="Top models by spend">
        <p className="text-xs text-muted-foreground">No model breakdown in this range.</p>
      </ChartCard>
    );
  }

  return (
    <ChartCard title="Cost by model" subtitle="Top models by spend">
      <div className="h-[240px] w-full">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={pieData}
              dataKey="value"
              nameKey="fullLabel"
              cx="50%"
              cy="50%"
              outerRadius="80%"
              label={({ name, value }) =>
                `${name} ${value > 0 ? formatCents(value) : ""}`
              }
            >
              {pieData.map((_, i) => (
                <Cell key={i} fill={colors[i % colors.length]} />
              ))}
            </Pie>
            <Tooltip
              formatter={(value: number) => formatCents(value)}
              content={({ active, payload }) => {
                if (!active || !payload?.length) return null;
                const item = payload[0].payload as (typeof pieData)[0];
                const full = byModel.find((r) => r.model === item.name);
                return (
                  <div className="rounded-md border border-border bg-card px-3 py-2 text-sm shadow-md">
                    <p className="font-medium">{item.fullLabel}</p>
                    <p>{formatCents(item.value)}</p>
                    {full && (
                      <p className="text-muted-foreground text-xs">
                        In {formatTokens(full.inputTokens)} / Out{" "}
                        {formatTokens(full.outputTokens)} tok
                      </p>
                    )}
                  </div>
                );
              }}
            />
          </PieChart>
        </ResponsiveContainer>
      </div>
    </ChartCard>
  );
}

export function TokensByModelBarChart({ byModel }: { byModel: CostByModel[] }) {
  const colors = useMemo(() => getResolvedChartColors(), []);

  const barData = useMemo(() => {
    const sorted = [...byModel].sort(
      (a, b) => b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens),
    );
    return sorted.slice(0, TOP_MODELS).map((row) => ({
      model: row.model,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      total: row.inputTokens + row.outputTokens,
    }));
  }, [byModel]);

  if (barData.length === 0) {
    return (
      <ChartCard title="Tokens by model" subtitle="Input vs output">
        <p className="text-xs text-muted-foreground">No token data in this range.</p>
      </ChartCard>
    );
  }

  return (
    <ChartCard title="Tokens by model" subtitle="Input vs output">
      <div className="h-[240px] w-full">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            data={barData}
            layout="vertical"
            margin={{ top: 8, right: 8, left: 60, bottom: 0 }}
          >
            <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
            <XAxis type="number" tick={{ fontSize: 10 }} tickFormatter={(v) => formatTokens(v)} />
            <YAxis
              type="category"
              dataKey="model"
              width={56}
              tick={{ fontSize: 9 }}
              tickFormatter={(v) => (v.length > 12 ? v.slice(0, 11) + "…" : v)}
            />
            <Tooltip
              content={({ active, payload }) => {
                if (!active || !payload?.length || !payload[0].payload) return null;
                const p = payload[0].payload as (typeof barData)[0];
                return (
                  <div className="rounded-md border border-border bg-card px-3 py-2 text-sm shadow-md">
                    <p className="font-medium">{p.model}</p>
                    <p>In {formatTokens(p.inputTokens)}</p>
                    <p>Out {formatTokens(p.outputTokens)}</p>
                  </div>
                );
              }}
            />
            <Legend />
            <Bar dataKey="inputTokens" fill={colors[0]} name="Input tokens" stackId="a" />
            <Bar dataKey="outputTokens" fill={colors[1]} name="Output tokens" stackId="a" />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </ChartCard>
  );
}
