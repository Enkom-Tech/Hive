import { and, eq, gt, isNull, ne, sql } from "drizzle-orm";
import type { Db } from "@hive/db";
import {
  agents,
  managedWorkerLinkEnrollmentTokens,
  workerInstanceAgents,
  workerInstances,
} from "@hive/db";
import { getConnectedManagedWorkerAgentIdsForCompany, isWorkerInstanceConnected } from "../../workers/worker-link.js";
import { parseDroneFromAgentMetadata } from "../../workers/worker-hello.js";
import { isPgUndefinedColumnError } from "./pg-errors.js";

/** Subset of fields used by the drone board overview (matches agent row normalization). */
export type DroneBoardAgentNormalized = {
  id: string;
  name: string;
  urlKey: string;
  status: string;
  lastHeartbeatAt: Date | string | null;
  metadata: unknown;
  workerPlacementMode?: string | null;
  operationalPosture?: string | null;
  role: string;
  adapterType: string;
};

export async function listDroneBoardAgentOverview(
  db: Db,
  normalizeAgentRow: (row: typeof agents.$inferSelect) => DroneBoardAgentNormalized,
  companyId: string,
) {
  const managedRows = await db
    .select()
    .from(agents)
    .where(
      and(
        eq(agents.companyId, companyId),
        ne(agents.status, "terminated"),
        eq(agents.adapterType, "managed_worker"),
      ),
    );
  const managed = managedRows.map(normalizeAgentRow);

  const pendingRows = await db
    .select({
      agentId: managedWorkerLinkEnrollmentTokens.agentId,
      pendingEnrollmentCount: sql<number>`count(*)::int`,
    })
    .from(managedWorkerLinkEnrollmentTokens)
    .where(
      and(
        eq(managedWorkerLinkEnrollmentTokens.companyId, companyId),
        isNull(managedWorkerLinkEnrollmentTokens.consumedAt),
        gt(managedWorkerLinkEnrollmentTokens.expiresAt, new Date()),
      ),
    )
    .groupBy(managedWorkerLinkEnrollmentTokens.agentId);

  const pendingMap = new Map(
    pendingRows.map((r) => [r.agentId, Number(r.pendingEnrollmentCount) || 0]),
  );

  const connectedIds = getConnectedManagedWorkerAgentIdsForCompany(companyId);
  const connectedSet = new Set(connectedIds);

  type BindingRow = {
    agentId: string;
    workerInstanceId: string;
    assignmentSource: string | null;
    instanceUuid: string;
    stableInstanceId: string;
    wiMetadata: unknown;
    wiLastSeen: Date | null;
    wiLabels: unknown;
    wiDrainRequestedAt: Date | null;
    wiCapacityHint: string | null;
  };

  let bindingRows: BindingRow[];
  try {
    bindingRows = await db
      .select({
        agentId: workerInstanceAgents.agentId,
        workerInstanceId: workerInstanceAgents.workerInstanceId,
        assignmentSource: workerInstanceAgents.assignmentSource,
        instanceUuid: workerInstances.id,
        stableInstanceId: workerInstances.stableInstanceId,
        wiMetadata: workerInstances.metadata,
        wiLastSeen: workerInstances.lastSeenAt,
        wiLabels: workerInstances.labels,
        wiDrainRequestedAt: workerInstances.drainRequestedAt,
        wiCapacityHint: workerInstances.capacityHint,
      })
      .from(workerInstanceAgents)
      .innerJoin(workerInstances, eq(workerInstanceAgents.workerInstanceId, workerInstances.id))
      .where(eq(workerInstances.companyId, companyId));
  } catch (e) {
    if (!isPgUndefinedColumnError(e)) throw e;
    const legacy = await db
      .select({
        agentId: workerInstanceAgents.agentId,
        workerInstanceId: workerInstanceAgents.workerInstanceId,
        instanceUuid: workerInstances.id,
        stableInstanceId: workerInstances.stableInstanceId,
        wiMetadata: workerInstances.metadata,
        wiLastSeen: workerInstances.lastSeenAt,
      })
      .from(workerInstanceAgents)
      .innerJoin(workerInstances, eq(workerInstanceAgents.workerInstanceId, workerInstances.id))
      .where(eq(workerInstances.companyId, companyId));
    bindingRows = legacy.map((r) => ({
      ...r,
      assignmentSource: "manual",
      wiLabels: null,
      wiDrainRequestedAt: null,
      wiCapacityHint: null,
    }));
  }

  const bindingByAgent = new Map(
    bindingRows.map((r) => [
      r.agentId,
      {
        workerInstanceId: r.workerInstanceId,
        assignmentSource: r.assignmentSource ?? "manual",
        instanceUuid: r.instanceUuid,
        stableInstanceId: r.stableInstanceId,
        wiMetadata: r.wiMetadata,
        wiLastSeen: r.wiLastSeen,
      },
    ]),
  );

  const instanceMeta = new Map<
    string,
    {
      id: string;
      stableInstanceId: string;
      wiMetadata: unknown;
      wiLastSeen: Date | null;
      labels: Record<string, unknown>;
      drainRequestedAt: Date | null;
      capacityHint: string | null;
    }
  >();
  for (const r of bindingRows) {
    if (!instanceMeta.has(r.instanceUuid)) {
      instanceMeta.set(r.instanceUuid, {
        id: r.instanceUuid,
        stableInstanceId: r.stableInstanceId,
        wiMetadata: r.wiMetadata,
        wiLastSeen: r.wiLastSeen,
        labels:
          r.wiLabels && typeof r.wiLabels === "object" && !Array.isArray(r.wiLabels)
            ? (r.wiLabels as Record<string, unknown>)
            : {},
        drainRequestedAt: r.wiDrainRequestedAt,
        capacityHint: r.wiCapacityHint,
      });
    }
  }

  try {
    const allCompanyInstances = await db
      .select({
        id: workerInstances.id,
        stableInstanceId: workerInstances.stableInstanceId,
        wiMetadata: workerInstances.metadata,
        wiLastSeen: workerInstances.lastSeenAt,
        wiLabels: workerInstances.labels,
        wiDrainRequestedAt: workerInstances.drainRequestedAt,
        wiCapacityHint: workerInstances.capacityHint,
      })
      .from(workerInstances)
      .where(eq(workerInstances.companyId, companyId));
    for (const wi of allCompanyInstances) {
      if (instanceMeta.has(wi.id)) continue;
      instanceMeta.set(wi.id, {
        id: wi.id,
        stableInstanceId: wi.stableInstanceId,
        wiMetadata: wi.wiMetadata,
        wiLastSeen: wi.wiLastSeen,
        labels:
          wi.wiLabels && typeof wi.wiLabels === "object" && !Array.isArray(wi.wiLabels)
            ? (wi.wiLabels as Record<string, unknown>)
            : {},
        drainRequestedAt: wi.wiDrainRequestedAt,
        capacityHint: wi.wiCapacityHint,
      });
    }
  } catch (e) {
    if (!isPgUndefinedColumnError(e)) throw e;
  }

  type AgentOverview = {
    agentId: string;
    name: string;
    urlKey: string;
    status: string;
    connected: boolean;
    lastHeartbeatAt: string | null;
    pendingEnrollmentCount: number;
    drone: ReturnType<typeof parseDroneFromAgentMetadata>;
    workerInstanceId: string | null;
    workerPlacementMode: string;
    operationalPosture: string;
    assignmentSource: string | null;
  };

  const toAgentOverview = (a: (typeof managed)[0]): AgentOverview => ({
    agentId: a.id,
    name: a.name,
    urlKey: a.urlKey,
    status: a.status,
    connected: connectedSet.has(a.id),
    lastHeartbeatAt:
      a.lastHeartbeatAt == null
        ? null
        : typeof a.lastHeartbeatAt === "string"
          ? a.lastHeartbeatAt
          : a.lastHeartbeatAt.toISOString(),
    pendingEnrollmentCount: pendingMap.get(a.id) ?? 0,
    drone: parseDroneFromAgentMetadata(a.metadata),
    workerInstanceId: bindingByAgent.get(a.id)?.workerInstanceId ?? null,
    workerPlacementMode: a.workerPlacementMode ?? "manual",
    operationalPosture: a.operationalPosture ?? "active",
    assignmentSource: bindingByAgent.get(a.id)?.assignmentSource ?? null,
  });

  const agentOverviews = managed.map(toAgentOverview);

  const trimMeta = (v: unknown): string | null => {
    if (typeof v !== "string") return null;
    const t = v.trim();
    return t.length ? t : null;
  };

  const instanceHeaderFields = (meta: unknown, wiLastSeen: Date | null) => {
    const m =
      meta && typeof meta === "object" && !Array.isArray(meta) ? (meta as Record<string, unknown>) : {};
    return {
      hostname: trimMeta(m.lastHostname),
      version: trimMeta(m.lastVersion),
      os: trimMeta(m.lastOs),
      arch: trimMeta(m.lastArch),
      lastHelloAt: trimMeta(m.lastHelloAt),
      lastSeenAt: wiLastSeen ? wiLastSeen.toISOString() : null,
    };
  };

  const byInstance = new Map<string, AgentOverview[]>();
  const unassignedBoardAgents: AgentOverview[] = [];

  for (const row of agentOverviews) {
    const b = bindingByAgent.get(row.agentId);
    if (b) {
      const list = byInstance.get(b.instanceUuid) ?? [];
      list.push(row);
      byInstance.set(b.instanceUuid, list);
    } else {
      unassignedBoardAgents.push(row);
    }
  }

  const instances = [...instanceMeta.values()]
    .map((inst) => {
      const boardAgentsForInstance = byInstance.get(inst.id) ?? [];
      const h = instanceHeaderFields(inst.wiMetadata, inst.wiLastSeen);
      return {
        id: inst.id,
        stableInstanceId: inst.stableInstanceId,
        hostname: h.hostname,
        version: h.version,
        os: h.os,
        arch: h.arch,
        lastHelloAt: h.lastHelloAt,
        lastSeenAt: h.lastSeenAt,
        labels: inst.labels,
        drainRequestedAt: inst.drainRequestedAt ? inst.drainRequestedAt.toISOString() : null,
        capacityHint: inst.capacityHint,
        connected: isWorkerInstanceConnected(inst.id, companyId),
        boardAgents: boardAgentsForInstance.sort((a, b) => a.name.localeCompare(b.name)),
      };
    })
    .sort((a, b) => {
      const ah = a.hostname ?? a.stableInstanceId;
      const bh = b.hostname ?? b.stableInstanceId;
      return ah.localeCompare(bh);
    });

  unassignedBoardAgents.sort((a, b) => a.name.localeCompare(b.name));

  const boardAgentsFlat = [...unassignedBoardAgents, ...instances.flatMap((i) => i.boardAgents)];

  return {
    instances,
    unassignedBoardAgents,
    boardAgents: boardAgentsFlat,
  };
}
