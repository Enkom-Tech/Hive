import type { ActivityEvent } from "./activity.js";
import type { HeartbeatRun } from "./heartbeat.js";

export interface AgentAttributionCost {
  spendCents: number;
  budgetCents: number;
  utilizationPercent: number;
  period?: { from: string; to: string };
}

export interface AgentAttribution {
  agentId: string;
  companyId: string;
  cost: AgentAttributionCost;
  activity: ActivityEvent[];
  runs: HeartbeatRun[];
  companySpendCents?: number;
  companyBudgetCents?: number;
}
