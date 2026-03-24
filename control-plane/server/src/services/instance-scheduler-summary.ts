import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@hive/db";
import { agents as agentsTable, companies } from "@hive/db";
import type { InstanceSchedulerHeartbeatAgent } from "@hive/shared";
import { deriveAgentUrlKey } from "@hive/shared";
import type { Principal } from "@hive/shared";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function parseBooleanLike(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (value === 1) return true;
    if (value === 0) return false;
    return null;
  }
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === "true" || normalized === "1" || normalized === "yes" || normalized === "on") return true;
  if (normalized === "false" || normalized === "0" || normalized === "no" || normalized === "off") return false;
  return null;
}

function parseNumberLike(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function parseSchedulerHeartbeatPolicy(runtimeConfig: unknown) {
  const heartbeat = asRecord(asRecord(runtimeConfig)?.heartbeat) ?? {};
  return {
    enabled: parseBooleanLike(heartbeat.enabled) ?? true,
    intervalSec: Math.max(0, parseNumberLike(heartbeat.intervalSec) ?? 0),
  };
}

/**
 * Scheduler-eligible agents with heartbeat policy (aligned with GET /instance/scheduler-heartbeats).
 */
export async function loadInstanceSchedulerAgents(
  db: Db,
  principal: Principal | null,
): Promise<InstanceSchedulerHeartbeatAgent[]> {
  const accessConditions = [];
  if (principal?.type !== "system" && !principal?.roles?.includes("instance_admin")) {
    const allowedCompanyIds = principal?.type === "user" ? (principal.company_ids ?? []) : [];
    if (allowedCompanyIds.length === 0) {
      return [];
    }
    accessConditions.push(inArray(agentsTable.companyId, allowedCompanyIds));
  }

  const rows = await db
    .select({
      id: agentsTable.id,
      companyId: agentsTable.companyId,
      agentName: agentsTable.name,
      role: agentsTable.role,
      title: agentsTable.title,
      status: agentsTable.status,
      adapterType: agentsTable.adapterType,
      runtimeConfig: agentsTable.runtimeConfig,
      lastHeartbeatAt: agentsTable.lastHeartbeatAt,
      companyName: companies.name,
      companyIssuePrefix: companies.issuePrefix,
    })
    .from(agentsTable)
    .innerJoin(companies, eq(agentsTable.companyId, companies.id))
    .where(accessConditions.length > 0 ? and(...accessConditions) : undefined)
    .orderBy(companies.name, agentsTable.name);

  const items: InstanceSchedulerHeartbeatAgent[] = rows
    .map((row) => {
      const policy = parseSchedulerHeartbeatPolicy(row.runtimeConfig);
      const statusEligible =
        row.status !== "paused" && row.status !== "terminated" && row.status !== "pending_approval";
      return {
        id: row.id,
        companyId: row.companyId,
        companyName: row.companyName,
        companyIssuePrefix: row.companyIssuePrefix,
        agentName: row.agentName,
        agentUrlKey: deriveAgentUrlKey(row.agentName, row.id),
        role: row.role as InstanceSchedulerHeartbeatAgent["role"],
        title: row.title,
        status: row.status as InstanceSchedulerHeartbeatAgent["status"],
        adapterType: row.adapterType,
        intervalSec: policy.intervalSec,
        heartbeatEnabled: policy.enabled,
        schedulerActive: statusEligible && policy.enabled && policy.intervalSec > 0,
        lastHeartbeatAt: row.lastHeartbeatAt,
      };
    })
    .filter(
      (item) =>
        item.intervalSec > 0 &&
        item.status !== "paused" &&
        item.status !== "terminated" &&
        item.status !== "pending_approval",
    )
    .sort((left, right) => {
      if (left.schedulerActive !== right.schedulerActive) return left.schedulerActive ? -1 : 1;
      const companyOrder = left.companyName.localeCompare(right.companyName);
      if (companyOrder !== 0) return companyOrder;
      return left.agentName.localeCompare(right.agentName);
    });

  return items;
}

export function summarizeSchedulerAgents(items: InstanceSchedulerHeartbeatAgent[], nowMs: number) {
  const active = items.filter((i) => i.schedulerActive);
  let staleCount = 0;
  let maxStalenessSeconds: number | null = null;

  for (const item of active) {
    const thresholdMs = Math.max(item.intervalSec * 2000, 120_000);
    const last = item.lastHeartbeatAt ? new Date(item.lastHeartbeatAt).getTime() : null;
    const ageMs = last === null ? Number.POSITIVE_INFINITY : nowMs - last;
    const stale = ageMs > thresholdMs;
    if (stale) staleCount += 1;
    if (last !== null) {
      const sec = Math.floor((nowMs - last) / 1000);
      if (maxStalenessSeconds === null || sec > maxStalenessSeconds) maxStalenessSeconds = sec;
    }
  }

  return {
    totalSchedulers: items.length,
    activeCount: active.length,
    staleCount,
    maxStalenessSeconds,
  };
}
