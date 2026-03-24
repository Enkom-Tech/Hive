import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { costsApi } from "../api/costs";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { formatCents, formatTokens } from "../lib/utils";
import { Identity } from "../components/Identity";
import { StatusBadge } from "../components/StatusBadge";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { DollarSign, Download } from "lucide-react";
import { CostOverTimeChart, CostByModelChart, TokensByModelBarChart } from "../components/CostCharts";

type DatePreset = "mtd" | "7d" | "30d" | "ytd" | "all" | "custom";

const PRESET_LABELS: Record<DatePreset, string> = {
  mtd: "Month to Date",
  "7d": "Last 7 Days",
  "30d": "Last 30 Days",
  ytd: "Year to Date",
  all: "All Time",
  custom: "Custom",
};

function escapeCsvCell(v: string | number): string {
  const s = String(v);
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function computeRange(preset: DatePreset): { from: string; to: string } {
  const now = new Date();
  const to = now.toISOString();
  switch (preset) {
    case "mtd": {
      const d = new Date(now.getFullYear(), now.getMonth(), 1);
      return { from: d.toISOString(), to };
    }
    case "7d": {
      const d = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      return { from: d.toISOString(), to };
    }
    case "30d": {
      const d = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      return { from: d.toISOString(), to };
    }
    case "ytd": {
      const d = new Date(now.getFullYear(), 0, 1);
      return { from: d.toISOString(), to };
    }
    case "all":
      return { from: "", to: "" };
    case "custom":
      return { from: "", to: "" };
  }
}

export function Costs() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();

  const [preset, setPreset] = useState<DatePreset>("mtd");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");

  useEffect(() => {
    setBreadcrumbs([{ label: "Costs" }]);
  }, [setBreadcrumbs]);

  const { from, to } = useMemo(() => {
    if (preset === "custom") {
      return {
        from: customFrom ? new Date(customFrom).toISOString() : "",
        to: customTo ? new Date(customTo + "T23:59:59.999Z").toISOString() : "",
      };
    }
    return computeRange(preset);
  }, [preset, customFrom, customTo]);

  const seriesBucket = useMemo((): "day" | "week" => {
    if (!from || !to) return "day";
    const fromDate = new Date(from);
    const toDate = new Date(to);
    const days = Math.ceil((toDate.getTime() - fromDate.getTime()) / (24 * 60 * 60 * 1000));
    return days > 31 ? "week" : "day";
  }, [from, to]);

  const { data, isLoading, error } = useQuery({
    queryKey: queryKeys.costs(
      selectedCompanyId!,
      from || undefined,
      to || undefined,
      seriesBucket,
    ),
    queryFn: async () => {
      const [summary, byAgent, byProject, series, byModel] = await Promise.all([
        costsApi.summary(selectedCompanyId!, from || undefined, to || undefined),
        costsApi.byAgent(selectedCompanyId!, from || undefined, to || undefined),
        costsApi.byProject(selectedCompanyId!, from || undefined, to || undefined),
        costsApi.series(
          selectedCompanyId!,
          from || undefined,
          to || undefined,
          seriesBucket,
        ),
        costsApi.byModel(selectedCompanyId!, from || undefined, to || undefined),
      ]);
      return { summary, byAgent, byProject, series, byModel };
    },
    enabled: !!selectedCompanyId,
  });

  if (!selectedCompanyId) {
    return <EmptyState icon={DollarSign} message="Select a company to view costs." />;
  }

  if (isLoading) {
    return <PageSkeleton variant="costs" />;
  }

  const presetKeys: DatePreset[] = ["mtd", "7d", "30d", "ytd", "all", "custom"];
  const exportDate = new Date().toISOString().slice(0, 10);

  function handleExportJSON() {
    if (!data || !selectedCompanyId) return;
    const payload = {
      summary: data.summary,
      byAgent: data.byAgent,
      byProject: data.byProject,
      series: data.series,
      byModel: data.byModel,
      meta: {
        companyId: selectedCompanyId,
        from: from || null,
        to: to || null,
        exportedAt: new Date().toISOString(),
      },
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: "application/json",
    });
    downloadBlob(blob, `costs-${selectedCompanyId}-${exportDate}.json`);
  }

  function handleExportCSV() {
    if (!data || !selectedCompanyId) return;
    const prefix = `costs-${selectedCompanyId}-${exportDate}`;

    const summaryHeaders = ["companyId", "spendCents", "budgetCents", "utilizationPercent"];
    const summaryRow = summaryHeaders
      .map((k) =>
        escapeCsvCell(
          String((data.summary as unknown as Record<string, unknown>)[k] ?? ""),
        ),
      )
      .join(",");
    downloadBlob(
      new Blob([summaryHeaders.join(",") + "\n" + summaryRow + "\n"], {
        type: "text/csv;charset=utf-8",
      }),
      `${prefix}-summary.csv`,
    );

    const byAgentHeaders = [
      "agentId",
      "agentName",
      "agentStatus",
      "costCents",
      "inputTokens",
      "outputTokens",
      "apiRunCount",
      "subscriptionRunCount",
    ];
    const byAgentRows = data.byAgent.map((row) =>
      byAgentHeaders
        .map((k) =>
          escapeCsvCell(
            String((row as unknown as Record<string, unknown>)[k] ?? ""),
          ),
        )
        .join(","),
    );
    downloadBlob(
      new Blob([byAgentHeaders.join(",") + "\n" + byAgentRows.join("\n") + "\n"], {
        type: "text/csv;charset=utf-8",
      }),
      `${prefix}-by-agent.csv`,
    );

    const byProjectHeaders = ["projectId", "projectName", "costCents", "inputTokens", "outputTokens"];
    const byProjectRows = data.byProject.map((row) =>
      byProjectHeaders
        .map((k) =>
          escapeCsvCell(
            String((row as unknown as Record<string, unknown>)[k] ?? ""),
          ),
        )
        .join(","),
    );
    downloadBlob(
      new Blob([byProjectHeaders.join(",") + "\n" + byProjectRows.join("\n") + "\n"], {
        type: "text/csv;charset=utf-8",
      }),
      `${prefix}-by-project.csv`,
    );

    const seriesHeaders = ["date", "costCents", "inputTokens", "outputTokens"];
    const seriesRows = data.series.map((row) =>
      seriesHeaders
        .map((k) =>
          escapeCsvCell(
            String((row as unknown as Record<string, unknown>)[k] ?? ""),
          ),
        )
        .join(","),
    );
    downloadBlob(
      new Blob([seriesHeaders.join(",") + "\n" + seriesRows.join("\n") + "\n"], {
        type: "text/csv;charset=utf-8",
      }),
      `${prefix}-series.csv`,
    );

    const byModelHeaders = ["model", "provider", "costCents", "inputTokens", "outputTokens"];
    const byModelRows = data.byModel.map((row) =>
      byModelHeaders
        .map((k) =>
          escapeCsvCell(
            String((row as unknown as Record<string, unknown>)[k] ?? ""),
          ),
        )
        .join(","),
    );
    downloadBlob(
      new Blob([byModelHeaders.join(",") + "\n" + byModelRows.join("\n") + "\n"], {
        type: "text/csv;charset=utf-8",
      }),
      `${prefix}-by-model.csv`,
    );
  }

  return (
    <div className="space-y-6">
      {/* Date range selector + Export */}
      <div className="flex flex-wrap items-center gap-2">
        {presetKeys.map((p) => (
          <Button
            key={p}
            variant={preset === p ? "secondary" : "ghost"}
            size="sm"
            onClick={() => setPreset(p)}
          >
            {PRESET_LABELS[p]}
          </Button>
        ))}
        {preset === "custom" && (
          <div className="flex items-center gap-2 ml-2">
            <input
              type="date"
              value={customFrom}
              onChange={(e) => setCustomFrom(e.target.value)}
              className="h-8 rounded-md border border-input bg-background px-2 text-sm text-foreground"
            />
            <span className="text-sm text-muted-foreground">to</span>
            <input
              type="date"
              value={customTo}
              onChange={(e) => setCustomTo(e.target.value)}
              className="h-8 rounded-md border border-input bg-background px-2 text-sm text-foreground"
            />
          </div>
        )}
        {data && (
          <div className="flex items-center gap-2 ml-auto">
            <Button variant="outline" size="sm" onClick={handleExportJSON}>
              <Download className="h-4 w-4 mr-1" />
              Export JSON
            </Button>
            <Button variant="outline" size="sm" onClick={handleExportCSV}>
              <Download className="h-4 w-4 mr-1" />
              Export CSV
            </Button>
          </div>
        )}
      </div>

      {error && <p className="text-sm text-destructive">{error.message}</p>}

      {data && (
        <>
          {/* Summary card */}
          <Card>
            <CardContent className="p-4 space-y-3">
              <div className="flex items-center justify-between">
                <p className="text-sm text-muted-foreground">{PRESET_LABELS[preset]}</p>
                {data.summary.budgetCents > 0 && (
                  <p className="text-sm text-muted-foreground">
                    {data.summary.utilizationPercent}% utilized
                  </p>
                )}
              </div>
              <p className="text-2xl font-bold tabular-nums">
                {formatCents(data.summary.spendCents)}{" "}
                <span className="text-base font-normal text-muted-foreground">
                  {data.summary.budgetCents > 0
                    ? `/ ${formatCents(data.summary.budgetCents)}`
                    : "Unlimited budget"}
                </span>
              </p>
              {data.summary.budgetCents > 0 && (
                <div className="w-full h-2 bg-muted rounded-full overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-[width,background-color] duration-150 ${
                      data.summary.utilizationPercent > 90
                        ? "bg-red-400"
                        : data.summary.utilizationPercent > 70
                          ? "bg-yellow-400"
                          : "bg-green-400"
                    }`}
                    style={{ width: `${Math.min(100, data.summary.utilizationPercent)}%` }}
                  />
                </div>
              )}
            </CardContent>
          </Card>

          {/* Charts */}
          <div className="grid md:grid-cols-2 gap-4">
            <CostOverTimeChart series={data.series} />
            <CostByModelChart byModel={data.byModel} />
          </div>
          <div className="grid md:grid-cols-1 gap-4">
            <TokensByModelBarChart byModel={data.byModel} />
          </div>

          {/* By Agent / By Project */}
          <div className="grid md:grid-cols-2 gap-4">
            <Card>
              <CardContent className="p-4">
                <h3 className="text-sm font-semibold mb-3">By Agent</h3>
                {data.byAgent.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No cost events yet.</p>
                ) : (
                  <div className="space-y-2">
                    {data.byAgent.map((row) => (
                      <div
                        key={row.agentId}
                        className="flex items-start justify-between text-sm"
                      >
                        <div className="flex items-center gap-2 min-w-0">
                          <Identity
                            name={row.agentName ?? row.agentId}
                            size="sm"
                          />
                          {row.agentStatus === "terminated" && (
                            <StatusBadge status="terminated" />
                          )}
                        </div>
                        <div className="text-right shrink-0 ml-2 tabular-nums">
                          <span className="font-medium block">{formatCents(row.costCents)}</span>
                          <span className="text-xs text-muted-foreground block">
                            in {formatTokens(row.inputTokens)} / out {formatTokens(row.outputTokens)} tok
                          </span>
                          {(row.apiRunCount > 0 || row.subscriptionRunCount > 0) && (
                            <span className="text-xs text-muted-foreground block">
                              {row.apiRunCount > 0 ? `api runs: ${row.apiRunCount}` : null}
                              {row.apiRunCount > 0 && row.subscriptionRunCount > 0 ? " | " : null}
                              {row.subscriptionRunCount > 0
                                ? `subscription runs: ${row.subscriptionRunCount} (${formatTokens(row.subscriptionInputTokens)} in / ${formatTokens(row.subscriptionOutputTokens)} out tok)`
                                : null}
                            </span>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardContent className="p-4">
                <h3 className="text-sm font-semibold mb-3">By Project</h3>
                {data.byProject.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No project-attributed run costs yet.</p>
                ) : (
                  <div className="space-y-2">
                    {data.byProject.map((row) => (
                      <div
                        key={row.projectId ?? "na"}
                        className="flex items-center justify-between text-sm"
                      >
                        <span className="truncate">
                          {row.projectName ?? row.projectId ?? "Unattributed"}
                        </span>
                        <span className="font-medium tabular-nums">{formatCents(row.costCents)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
