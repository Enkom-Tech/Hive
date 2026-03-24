import type {
  CostSummary,
  CostByAgent,
  CostSeriesPoint,
  CostByModel,
} from "@hive/shared";
import { api } from "./client";

export interface CostByProject {
  projectId: string | null;
  projectName: string | null;
  costCents: number;
  inputTokens: number;
  outputTokens: number;
}

function dateParams(from?: string, to?: string, bucket?: "day" | "week"): string {
  const params = new URLSearchParams();
  if (from) params.set("from", from);
  if (to) params.set("to", to);
  if (bucket) params.set("bucket", bucket);
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

export const costsApi = {
  summary: (companyId: string, from?: string, to?: string) =>
    api.get<CostSummary>(`/companies/${companyId}/costs/summary${dateParams(from, to)}`),
  byAgent: (companyId: string, from?: string, to?: string) =>
    api.get<CostByAgent[]>(`/companies/${companyId}/costs/by-agent${dateParams(from, to)}`),
  byProject: (companyId: string, from?: string, to?: string) =>
    api.get<CostByProject[]>(`/companies/${companyId}/costs/by-project${dateParams(from, to)}`),
  series: (
    companyId: string,
    from?: string,
    to?: string,
    bucket?: "day" | "week",
  ) =>
    api.get<CostSeriesPoint[]>(
      `/companies/${companyId}/costs/series${dateParams(from, to, bucket)}`,
    ),
  byModel: (companyId: string, from?: string, to?: string) =>
    api.get<CostByModel[]>(`/companies/${companyId}/costs/by-model${dateParams(from, to)}`),
};
