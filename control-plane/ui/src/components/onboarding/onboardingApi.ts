import type { QueryClient } from "@tanstack/react-query";
import type { Agent } from "@hive/shared";
import { agentsApi } from "../../api/agents";
import { companiesApi } from "../../api/companies";
import { goalsApi } from "../../api/goals";
import { getUIAdapter } from "../../adapters";
import { defaultCreateValues } from "../agent-config-defaults";
import { parseOnboardingGoalInput } from "../../lib/onboarding-goal";
import { queryKeys } from "../../lib/queryKeys";

const COO_DEFAULT_NAME = "COO";

function buildManagedWorkerCreatePayload(opts: {
  name: string;
  timeoutMs: number;
  promptTemplate: string;
}): Record<string, unknown> {
  const adapter = getUIAdapter("managed_worker");
  const baseConfig = adapter.buildAdapterConfig({
    ...defaultCreateValues,
    adapterType: "managed_worker",
    timeoutMs: opts.timeoutMs,
    promptTemplate: opts.promptTemplate,
  });
  const adapterConfig: Record<string, unknown> = {
    ...baseConfig,
    ...(opts.promptTemplate.trim() ? { promptTemplate: opts.promptTemplate.trim() } : {}),
  };
  return {
    name: opts.name.trim(),
    role: "general",
    adapterType: "managed_worker",
    adapterConfig,
    runtimeConfig: {
      heartbeat: {
        enabled: true,
        intervalSec: 3600,
        wakeOnDemand: true,
        cooldownSec: 10,
        maxConcurrentRuns: 1,
      },
    },
  };
}

export async function createCompanyWithGoal(
  queryClient: QueryClient,
  companyName: string,
  goalText: string,
  setSelectedCompanyId: (id: string) => void,
): Promise<{ id: string; issuePrefix: string }> {
  const company = await companiesApi.create({ name: companyName.trim() });
  setSelectedCompanyId(company.id);
  queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });

  const parsed = parseOnboardingGoalInput(goalText);
  if (parsed.title.trim()) {
    await goalsApi.create(company.id, {
      title: parsed.title,
      ...(parsed.description ? { description: parsed.description } : {}),
      level: "company",
      status: "active",
    });
    queryClient.invalidateQueries({ queryKey: queryKeys.goals.list(company.id) });
  }

  return { id: company.id, issuePrefix: company.issuePrefix };
}

function goalTextAsPromptTemplate(goalText: string): string {
  const parsed = parseOnboardingGoalInput(goalText);
  if (!parsed.title.trim()) return "";
  return parsed.description ? `${parsed.title}\n${parsed.description}` : parsed.title;
}

/**
 * Picks the first non-terminated managed_worker agent, or creates a COO agent.
 * Worker enrollment tokens are per-agent; the COO must exist before the Worker step can mint tokens.
 */
export async function ensureCooAgent(
  queryClient: QueryClient,
  companyId: string,
  goalText: string,
): Promise<Agent> {
  const agents = await agentsApi.list(companyId);
  const existing = agents.find(
    (a) => a.status !== "terminated" && a.adapterType === "managed_worker",
  );
  if (existing) {
    queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(companyId) });
    return existing;
  }

  const promptTemplate = goalTextAsPromptTemplate(goalText);
  const agent = await agentsApi.create(
    companyId,
    buildManagedWorkerCreatePayload({
      name: COO_DEFAULT_NAME,
      timeoutMs: 15000,
      promptTemplate,
    }),
  );
  queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(companyId) });
  return agent;
}

export async function updateCooFromOnboarding(
  queryClient: QueryClient,
  companyId: string,
  agentId: string,
  patch: { name: string; focusText: string; timeoutMs: number },
): Promise<Agent> {
  const current = await agentsApi.get(agentId, companyId);
  const adapter = getUIAdapter("managed_worker");
  const prevConfig = (current.adapterConfig ?? {}) as Record<string, unknown>;
  const base = adapter.buildAdapterConfig({
    ...defaultCreateValues,
    adapterType: "managed_worker",
    timeoutMs: patch.timeoutMs,
    promptTemplate: patch.focusText.trim(),
  });
  const adapterConfig: Record<string, unknown> = {
    ...prevConfig,
    ...base,
    ...(patch.focusText.trim() ? { promptTemplate: patch.focusText.trim() } : { promptTemplate: "" }),
  };
  const updated = await agentsApi.update(
    agentId,
    {
      name: patch.name.trim(),
      adapterConfig,
    },
    companyId,
  );
  queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(companyId) });
  queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agentId) });
  return updated;
}
