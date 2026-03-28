import type { AdapterRuntimeServiceReport } from "@hive/adapter-utils";
import type { Db } from "@hive/db";
import { workspaceRuntimeServices } from "@hive/db";
import { and, desc, eq, inArray } from "drizzle-orm";
import { normalizeAdapterManagedRuntimeServices } from "./adapter-managed.js";
import type {
  ExecutionWorkspaceAgentRef,
  ExecutionWorkspaceIssueRef,
  RealizedExecutionWorkspace,
  RuntimeServiceRecord,
} from "./types.js";

export function toPersistedWorkspaceRuntimeService(record: RuntimeServiceRecord): typeof workspaceRuntimeServices.$inferInsert {
  return {
    id: record.id,
    companyId: record.companyId,
    projectId: record.projectId,
    projectWorkspaceId: record.projectWorkspaceId,
    issueId: record.issueId,
    scopeType: record.scopeType,
    scopeId: record.scopeId,
    serviceName: record.serviceName,
    status: record.status,
    lifecycle: record.lifecycle,
    reuseKey: record.reuseKey,
    command: record.command,
    cwd: record.cwd,
    port: record.port,
    url: record.url,
    provider: record.provider,
    providerRef: record.providerRef,
    ownerAgentId: record.ownerAgentId,
    startedByRunId: record.startedByRunId,
    lastUsedAt: new Date(record.lastUsedAt),
    startedAt: new Date(record.startedAt),
    stoppedAt: record.stoppedAt ? new Date(record.stoppedAt) : null,
    stopPolicy: record.stopPolicy,
    healthStatus: record.healthStatus,
    updatedAt: new Date(),
  };
}

export async function persistRuntimeServiceRecord(db: Db | undefined, record: RuntimeServiceRecord) {
  if (!db) return;
  const values = toPersistedWorkspaceRuntimeService(record);
  await db
    .insert(workspaceRuntimeServices)
    .values(values)
    .onConflictDoUpdate({
      target: workspaceRuntimeServices.id,
      set: {
        projectId: values.projectId,
        projectWorkspaceId: values.projectWorkspaceId,
        issueId: values.issueId,
        scopeType: values.scopeType,
        scopeId: values.scopeId,
        serviceName: values.serviceName,
        status: values.status,
        lifecycle: values.lifecycle,
        reuseKey: values.reuseKey,
        command: values.command,
        cwd: values.cwd,
        port: values.port,
        url: values.url,
        provider: values.provider,
        providerRef: values.providerRef,
        ownerAgentId: values.ownerAgentId,
        startedByRunId: values.startedByRunId,
        lastUsedAt: values.lastUsedAt,
        startedAt: values.startedAt,
        stoppedAt: values.stoppedAt,
        stopPolicy: values.stopPolicy,
        healthStatus: values.healthStatus,
        updatedAt: values.updatedAt,
      },
    });
}

export async function listWorkspaceRuntimeServicesForProjectWorkspaces(
  db: Db,
  companyId: string,
  projectWorkspaceIds: string[],
) {
  if (projectWorkspaceIds.length === 0) return new Map<string, typeof workspaceRuntimeServices.$inferSelect[]>();
  const rows = await db
    .select()
    .from(workspaceRuntimeServices)
    .where(
      and(
        eq(workspaceRuntimeServices.companyId, companyId),
        inArray(workspaceRuntimeServices.projectWorkspaceId, projectWorkspaceIds),
      ),
    )
    .orderBy(desc(workspaceRuntimeServices.updatedAt), desc(workspaceRuntimeServices.createdAt));

  const grouped = new Map<string, typeof workspaceRuntimeServices.$inferSelect[]>();
  for (const row of rows) {
    if (!row.projectWorkspaceId) continue;
    const existing = grouped.get(row.projectWorkspaceId);
    if (existing) existing.push(row);
    else grouped.set(row.projectWorkspaceId, [row]);
  }
  return grouped;
}

export async function reconcilePersistedRuntimeServicesOnStartup(db: Db) {
  const staleRows = await db
    .select({ id: workspaceRuntimeServices.id })
    .from(workspaceRuntimeServices)
    .where(
      and(
        eq(workspaceRuntimeServices.provider, "local_process"),
        inArray(workspaceRuntimeServices.status, ["starting", "running"]),
      ),
    );

  if (staleRows.length === 0) return { reconciled: 0 };

  const now = new Date();
  await db
    .update(workspaceRuntimeServices)
    .set({
      status: "stopped",
      healthStatus: "unknown",
      stoppedAt: now,
      lastUsedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(workspaceRuntimeServices.provider, "local_process"),
        inArray(workspaceRuntimeServices.status, ["starting", "running"]),
      ),
    );

  return { reconciled: staleRows.length };
}

export async function persistAdapterManagedRuntimeServices(input: {
  db: Db;
  adapterType: string;
  runId: string;
  agent: ExecutionWorkspaceAgentRef;
  issue: ExecutionWorkspaceIssueRef | null;
  workspace: RealizedExecutionWorkspace;
  reports: AdapterRuntimeServiceReport[];
}) {
  const refs = normalizeAdapterManagedRuntimeServices(input);
  if (refs.length === 0) return refs;

  const existingRows = await input.db
    .select()
    .from(workspaceRuntimeServices)
    .where(inArray(workspaceRuntimeServices.id, refs.map((ref) => ref.id)));
  const existingById = new Map(existingRows.map((row) => [row.id, row]));

  for (const ref of refs) {
    const existing = existingById.get(ref.id);
    const startedAt = existing?.startedAt ?? new Date(ref.startedAt);
    const createdAt = existing?.createdAt ?? new Date();
    await input.db
      .insert(workspaceRuntimeServices)
      .values({
        id: ref.id,
        companyId: ref.companyId,
        projectId: ref.projectId,
        projectWorkspaceId: ref.projectWorkspaceId,
        issueId: ref.issueId,
        scopeType: ref.scopeType,
        scopeId: ref.scopeId,
        serviceName: ref.serviceName,
        status: ref.status,
        lifecycle: ref.lifecycle,
        reuseKey: ref.reuseKey,
        command: ref.command,
        cwd: ref.cwd,
        port: ref.port,
        url: ref.url,
        provider: ref.provider,
        providerRef: ref.providerRef,
        ownerAgentId: ref.ownerAgentId,
        startedByRunId: ref.startedByRunId,
        lastUsedAt: new Date(ref.lastUsedAt),
        startedAt,
        stoppedAt: ref.stoppedAt ? new Date(ref.stoppedAt) : null,
        stopPolicy: ref.stopPolicy,
        healthStatus: ref.healthStatus,
        createdAt,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: workspaceRuntimeServices.id,
        set: {
          projectId: ref.projectId,
          projectWorkspaceId: ref.projectWorkspaceId,
          issueId: ref.issueId,
          scopeType: ref.scopeType,
          scopeId: ref.scopeId,
          serviceName: ref.serviceName,
          status: ref.status,
          lifecycle: ref.lifecycle,
          reuseKey: ref.reuseKey,
          command: ref.command,
          cwd: ref.cwd,
          port: ref.port,
          url: ref.url,
          provider: ref.provider,
          providerRef: ref.providerRef,
          ownerAgentId: ref.ownerAgentId,
          startedByRunId: ref.startedByRunId,
          lastUsedAt: new Date(ref.lastUsedAt),
          startedAt,
          stoppedAt: ref.stoppedAt ? new Date(ref.stoppedAt) : null,
          stopPolicy: ref.stopPolicy,
          healthStatus: ref.healthStatus,
          updatedAt: new Date(),
        },
      });
  }

  return refs;
}
