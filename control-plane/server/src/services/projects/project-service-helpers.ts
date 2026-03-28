import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type { Db, DbTransaction } from "@hive/db";
import { projects, projectGoals, goals, projectWorkspaces, workspaceRuntimeServices } from "@hive/db";
import {
  PROJECT_COLORS,
  deriveProjectUrlKey,
  isUuidLike,
  normalizeProjectUrlKey,
  type ProjectExecutionWorkspacePolicy,
  type ProjectGoalRef,
  type ProjectWorkspace,
  type WorkspaceRuntimeService,
} from "@hive/shared";
import { listWorkspaceRuntimeServicesForProjectWorkspaces } from "../workspace-runtime.js";
import { parseProjectExecutionWorkspacePolicy } from "../execution-workspace-policy.js";

type ProjectRow = typeof projects.$inferSelect;
type ProjectWorkspaceRow = typeof projectWorkspaces.$inferSelect;
type WorkspaceRuntimeServiceRow = typeof workspaceRuntimeServices.$inferSelect;
const REPO_ONLY_CWD_SENTINEL = "/__HIVE_repo_only__";
export type CreateWorkspaceInput = {
  name?: string | null;
  cwd?: string | null;
  repoUrl?: string | null;
  repoRef?: string | null;
  metadata?: Record<string, unknown> | null;
  isPrimary?: boolean;
};
export type UpdateWorkspaceInput = Partial<CreateWorkspaceInput>;

export interface ProjectWithGoals extends Omit<ProjectRow, "executionWorkspacePolicy"> {
  urlKey: string;
  goalIds: string[];
  goals: ProjectGoalRef[];
  executionWorkspacePolicy: ProjectExecutionWorkspacePolicy | null;
  workspaces: ProjectWorkspace[];
  primaryWorkspace: ProjectWorkspace | null;
}

interface ProjectShortnameRow {
  id: string;
  name: string;
}

interface ResolveProjectNameOptions {
  excludeProjectId?: string | null;
}

/** Batch-load goal refs for a set of projects. */
export async function attachGoals(db: Db, rows: ProjectRow[]): Promise<ProjectWithGoals[]> {
  if (rows.length === 0) return [];

  const projectIds = rows.map((r) => r.id);

  // Fetch join rows + goal titles in one query
  const links = await db
    .select({
      projectId: projectGoals.projectId,
      goalId: projectGoals.goalId,
      goalTitle: goals.title,
    })
    .from(projectGoals)
    .innerJoin(goals, eq(projectGoals.goalId, goals.id))
    .where(inArray(projectGoals.projectId, projectIds));

  const map = new Map<string, ProjectGoalRef[]>();
  for (const link of links) {
    let arr = map.get(link.projectId);
    if (!arr) {
      arr = [];
      map.set(link.projectId, arr);
    }
    arr.push({ id: link.goalId, title: link.goalTitle });
  }

  return rows.map((r) => {
    const g = map.get(r.id) ?? [];
    return {
      ...r,
      urlKey: deriveProjectUrlKey(r.name, r.id),
      goalIds: g.map((x) => x.id),
      goals: g,
      executionWorkspacePolicy: parseProjectExecutionWorkspacePolicy(r.executionWorkspacePolicy),
    } as ProjectWithGoals;
  });
}

export function toRuntimeService(row: WorkspaceRuntimeServiceRow): WorkspaceRuntimeService {
  return {
    id: row.id,
    companyId: row.companyId,
    projectId: row.projectId ?? null,
    projectWorkspaceId: row.projectWorkspaceId ?? null,
    issueId: row.issueId ?? null,
    scopeType: row.scopeType as WorkspaceRuntimeService["scopeType"],
    scopeId: row.scopeId ?? null,
    serviceName: row.serviceName,
    status: row.status as WorkspaceRuntimeService["status"],
    lifecycle: row.lifecycle as WorkspaceRuntimeService["lifecycle"],
    reuseKey: row.reuseKey ?? null,
    command: row.command ?? null,
    cwd: row.cwd ?? null,
    port: row.port ?? null,
    url: row.url ?? null,
    provider: row.provider as WorkspaceRuntimeService["provider"],
    providerRef: row.providerRef ?? null,
    ownerAgentId: row.ownerAgentId ?? null,
    startedByRunId: row.startedByRunId ?? null,
    lastUsedAt: row.lastUsedAt,
    startedAt: row.startedAt,
    stoppedAt: row.stoppedAt ?? null,
    stopPolicy: (row.stopPolicy as Record<string, unknown> | null) ?? null,
    healthStatus: row.healthStatus as WorkspaceRuntimeService["healthStatus"],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function toWorkspace(
  row: ProjectWorkspaceRow,
  runtimeServices: WorkspaceRuntimeService[] = [],
): ProjectWorkspace {
  return {
    id: row.id,
    companyId: row.companyId,
    projectId: row.projectId,
    name: row.name,
    cwd: row.cwd,
    repoUrl: row.repoUrl ?? null,
    repoRef: row.repoRef ?? null,
    metadata: (row.metadata as Record<string, unknown> | null) ?? null,
    isPrimary: row.isPrimary,
    runtimeServices,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function pickPrimaryWorkspace(
  rows: ProjectWorkspaceRow[],
  runtimeServicesByWorkspaceId?: Map<string, WorkspaceRuntimeService[]>,
): ProjectWorkspace | null {
  if (rows.length === 0) return null;
  const explicitPrimary = rows.find((row) => row.isPrimary);
  const primary = explicitPrimary ?? rows[0];
  return toWorkspace(primary, runtimeServicesByWorkspaceId?.get(primary.id) ?? []);
}

/** Batch-load workspace refs for a set of projects. */
export async function attachWorkspaces(db: Db, rows: ProjectWithGoals[]): Promise<ProjectWithGoals[]> {
  if (rows.length === 0) return [];

  const projectIds = rows.map((r) => r.id);
  const workspaceRows = await db
    .select()
    .from(projectWorkspaces)
    .where(inArray(projectWorkspaces.projectId, projectIds))
    .orderBy(desc(projectWorkspaces.isPrimary), asc(projectWorkspaces.createdAt), asc(projectWorkspaces.id));
  const runtimeServicesByWorkspaceId = await listWorkspaceRuntimeServicesForProjectWorkspaces(
    db,
    rows[0]!.companyId,
    workspaceRows.map((workspace) => workspace.id),
  );
  const sharedRuntimeServicesByWorkspaceId = new Map(
    Array.from(runtimeServicesByWorkspaceId.entries()).map(([workspaceId, services]) => [
      workspaceId,
      services.map(toRuntimeService),
    ]),
  );

  const map = new Map<string, ProjectWorkspaceRow[]>();
  for (const row of workspaceRows) {
    let arr = map.get(row.projectId);
    if (!arr) {
      arr = [];
      map.set(row.projectId, arr);
    }
    arr.push(row);
  }

  return rows.map((row) => {
    const projectWorkspaceRows = map.get(row.id) ?? [];
    const workspaces = projectWorkspaceRows.map((workspace) =>
      toWorkspace(
        workspace,
        sharedRuntimeServicesByWorkspaceId.get(workspace.id) ?? [],
      ),
    );
    return {
      ...row,
      workspaces,
      primaryWorkspace: pickPrimaryWorkspace(projectWorkspaceRows, sharedRuntimeServicesByWorkspaceId),
    };
  });
}

/** Sync the project_goals join table for a single project. */
export async function syncGoalLinks(db: Db, projectId: string, companyId: string, goalIds: string[]) {
  // Delete existing links
  await db.delete(projectGoals).where(eq(projectGoals.projectId, projectId));

  // Insert new links
  if (goalIds.length > 0) {
    await db.insert(projectGoals).values(
      goalIds.map((goalId) => ({ projectId, goalId, companyId })),
    );
  }
}

/** Resolve goalIds from input, handling the legacy goalId field. */
export function resolveGoalIds(data: { goalIds?: string[]; goalId?: string | null }): string[] | undefined {
  if (data.goalIds !== undefined) return data.goalIds;
  if (data.goalId !== undefined) {
    return data.goalId ? [data.goalId] : [];
  }
  return undefined;
}

export function readNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function normalizeWorkspaceCwd(value: unknown): string | null {
  const cwd = readNonEmptyString(value);
  if (!cwd) return null;
  return cwd === REPO_ONLY_CWD_SENTINEL ? null : cwd;
}

function deriveNameFromCwd(cwd: string): string {
  const normalized = cwd.replace(/[\\/]+$/, "");
  const segments = normalized.split(/[\\/]/).filter(Boolean);
  return segments[segments.length - 1] ?? "Local folder";
}

function deriveNameFromRepoUrl(repoUrl: string): string {
  try {
    const url = new URL(repoUrl);
    const cleanedPath = url.pathname.replace(/\/+$/, "");
    const lastSegment = cleanedPath.split("/").filter(Boolean).pop() ?? "";
    const noGitSuffix = lastSegment.replace(/\.git$/i, "");
    return noGitSuffix || repoUrl;
  } catch {
    return repoUrl;
  }
}

export function deriveWorkspaceName(input: {
  name?: string | null;
  cwd?: string | null;
  repoUrl?: string | null;
}) {
  const explicit = readNonEmptyString(input.name);
  if (explicit) return explicit;

  const cwd = readNonEmptyString(input.cwd);
  if (cwd) return deriveNameFromCwd(cwd);

  const repoUrl = readNonEmptyString(input.repoUrl);
  if (repoUrl) return deriveNameFromRepoUrl(repoUrl);

  return "Workspace";
}

export function resolveProjectNameForUniqueShortname(
  requestedName: string,
  existingProjects: ProjectShortnameRow[],
  options?: ResolveProjectNameOptions,
): string {
  const requestedShortname = normalizeProjectUrlKey(requestedName);
  if (!requestedShortname) return requestedName;

  const usedShortnames = new Set(
    existingProjects
      .filter((project) => !(options?.excludeProjectId && project.id === options.excludeProjectId))
      .map((project) => normalizeProjectUrlKey(project.name))
      .filter((value): value is string => value !== null),
  );
  if (!usedShortnames.has(requestedShortname)) return requestedName;

  for (let suffix = 2; suffix < 10_000; suffix += 1) {
    const candidateName = `${requestedName} ${suffix}`;
    const candidateShortname = normalizeProjectUrlKey(candidateName);
    if (candidateShortname && !usedShortnames.has(candidateShortname)) {
      return candidateName;
    }
  }

  // Fallback guard for pathological naming collisions.
  return `${requestedName} ${Date.now()}`;
}

export async function ensureSinglePrimaryWorkspace(
  dbOrTx: Db | DbTransaction,
  input: {
    companyId: string;
    projectId: string;
    keepWorkspaceId: string;
  },
) {
  await dbOrTx
    .update(projectWorkspaces)
    .set({ isPrimary: false, updatedAt: new Date() })
    .where(
      and(
        eq(projectWorkspaces.companyId, input.companyId),
        eq(projectWorkspaces.projectId, input.projectId),
      ),
    );

  await dbOrTx
    .update(projectWorkspaces)
    .set({ isPrimary: true, updatedAt: new Date() })
    .where(
      and(
        eq(projectWorkspaces.companyId, input.companyId),
        eq(projectWorkspaces.projectId, input.projectId),
        eq(projectWorkspaces.id, input.keepWorkspaceId),
      ),
    );
}

