import fs from "node:fs/promises";
import { and, asc, eq } from "drizzle-orm";
import type { Db } from "@hive/db";
import { agents, issues, projectWorkspaces } from "@hive/db";
import type { AdapterExecutionResult, AdapterSessionCodec } from "../../adapters/index.js";
import { parseObject } from "../../adapters/utils.js";
import {
  hiveInstanceRelativePathIfUnderRoot,
  resolveDefaultAgentWorkspaceDir,
} from "../../home-paths.js";
import {
  normalizeSessionParams,
  readNonEmptyString,
  truncateDisplayId,
  type ResolvedWorkspaceForRun,
} from "./types.js";
import { REPO_ONLY_CWD_SENTINEL } from "./types.js";

function pathForWorkspaceWarning(absolutePath: string): string {
  return hiveInstanceRelativePathIfUnderRoot(absolutePath) ?? absolutePath;
}

const defaultSessionCodec: AdapterSessionCodec = {
  deserialize(raw: unknown) {
    const asObj = parseObject(raw);
    if (Object.keys(asObj).length > 0) return asObj;
    const sessionId = readNonEmptyString((raw as Record<string, unknown> | null)?.sessionId);
    if (sessionId) return { sessionId };
    return null;
  },
  serialize(params: Record<string, unknown> | null) {
    if (!params || Object.keys(params).length === 0) return null;
    return params;
  },
  getDisplayId(params: Record<string, unknown> | null) {
    return readNonEmptyString(params?.sessionId);
  },
};

export function getDefaultSessionCodec(): AdapterSessionCodec {
  return defaultSessionCodec;
}

export function resolveNextSessionState(input: {
  codec: AdapterSessionCodec;
  adapterResult: AdapterExecutionResult;
  previousParams: Record<string, unknown> | null;
  previousDisplayId: string | null;
  previousLegacySessionId: string | null;
}) {
  const { codec, adapterResult, previousParams, previousDisplayId, previousLegacySessionId } = input;

  if (adapterResult.clearSession) {
    return {
      params: null as Record<string, unknown> | null,
      displayId: null as string | null,
      legacySessionId: null as string | null,
    };
  }

  const explicitParams = adapterResult.sessionParams;
  const hasExplicitParams = adapterResult.sessionParams !== undefined;
  const hasExplicitSessionId = adapterResult.sessionId !== undefined;
  const explicitSessionId = readNonEmptyString(adapterResult.sessionId);
  const hasExplicitDisplay = adapterResult.sessionDisplayId !== undefined;
  const explicitDisplayId = readNonEmptyString(adapterResult.sessionDisplayId);
  const shouldUsePrevious = !hasExplicitParams && !hasExplicitSessionId && !hasExplicitDisplay;

  const candidateParams = hasExplicitParams
    ? explicitParams
    : hasExplicitSessionId
      ? (explicitSessionId ? { sessionId: explicitSessionId } : null)
      : previousParams;

  const serialized = normalizeSessionParams(codec.serialize(normalizeSessionParams(candidateParams) ?? null));
  const deserialized = normalizeSessionParams(codec.deserialize(serialized));

  const displayId = truncateDisplayId(
    explicitDisplayId ??
      (codec.getDisplayId ? codec.getDisplayId(deserialized) : null) ??
      readNonEmptyString(deserialized?.sessionId) ??
      (shouldUsePrevious ? previousDisplayId : null) ??
      explicitSessionId ??
      (shouldUsePrevious ? previousLegacySessionId : null),
  );

  const legacySessionId =
    explicitSessionId ??
    readNonEmptyString(deserialized?.sessionId) ??
    displayId ??
    (shouldUsePrevious ? previousLegacySessionId : null);

  return {
    params: serialized,
    displayId,
    legacySessionId,
  };
}

export async function resolveWorkspaceForRun(
  db: Db,
  agent: typeof agents.$inferSelect,
  context: Record<string, unknown>,
  previousSessionParams: Record<string, unknown> | null,
  opts?: { useProjectWorkspace?: boolean | null },
): Promise<ResolvedWorkspaceForRun> {
  const issueId = readNonEmptyString(context.issueId);
  const contextProjectId = readNonEmptyString(context.projectId);
  const issueProjectId = issueId
    ? await db
        .select({ projectId: issues.projectId })
        .from(issues)
        .where(and(eq(issues.id, issueId), eq(issues.companyId, agent.companyId)))
        .then((rows) => rows[0]?.projectId ?? null)
    : null;
  const resolvedProjectId = issueProjectId ?? contextProjectId;
  const useProjectWorkspace = opts?.useProjectWorkspace !== false;
  const workspaceProjectId = useProjectWorkspace ? resolvedProjectId : null;

  const projectWorkspaceRows = workspaceProjectId
    ? await db
        .select()
        .from(projectWorkspaces)
        .where(
          and(
            eq(projectWorkspaces.companyId, agent.companyId),
            eq(projectWorkspaces.projectId, workspaceProjectId),
          ),
        )
        .orderBy(asc(projectWorkspaces.createdAt), asc(projectWorkspaces.id))
    : [];

  const workspaceHints = projectWorkspaceRows.map((workspace) => ({
    workspaceId: workspace.id,
    cwd: readNonEmptyString(workspace.cwd),
    repoUrl: readNonEmptyString(workspace.repoUrl),
    repoRef: readNonEmptyString(workspace.repoRef),
  }));

  if (projectWorkspaceRows.length > 0) {
    const missingProjectCwds: string[] = [];
    let hasConfiguredProjectCwd = false;
    for (const workspace of projectWorkspaceRows) {
      const projectCwd = readNonEmptyString(workspace.cwd);
      if (!projectCwd || projectCwd === REPO_ONLY_CWD_SENTINEL) continue;
      hasConfiguredProjectCwd = true;
      const projectCwdExists = await fs
        .stat(projectCwd)
        .then((stats) => stats.isDirectory())
        .catch(() => false);
      if (projectCwdExists) {
        return {
          cwd: projectCwd,
          source: "project_primary",
          projectId: resolvedProjectId,
          workspaceId: workspace.id,
          repoUrl: workspace.repoUrl,
          repoRef: workspace.repoRef,
          workspaceHints,
          warnings: [],
        };
      }
      missingProjectCwds.push(projectCwd);
    }

    const fallbackCwd = resolveDefaultAgentWorkspaceDir(agent.id);
    await fs.mkdir(fallbackCwd, { recursive: true });
    const warnings: string[] = [];
    if (missingProjectCwds.length > 0) {
      const firstMissing = missingProjectCwds[0];
      const extraMissingCount = Math.max(0, missingProjectCwds.length - 1);
      const fb = pathForWorkspaceWarning(fallbackCwd);
      const miss = pathForWorkspaceWarning(firstMissing);
      warnings.push(
        extraMissingCount > 0
          ? `Project workspace path "${miss}" and ${extraMissingCount} other configured path(s) are not available yet. Using fallback workspace "${fb}" for this run.`
          : `Project workspace path "${miss}" is not available yet. Using fallback workspace "${fb}" for this run.`,
      );
    } else if (!hasConfiguredProjectCwd) {
      warnings.push(
        `Project workspace has no local cwd configured. Using fallback workspace "${pathForWorkspaceWarning(fallbackCwd)}" for this run.`,
      );
    }
    return {
      cwd: fallbackCwd,
      source: "project_primary",
      projectId: resolvedProjectId,
      workspaceId: projectWorkspaceRows[0]?.id ?? null,
      repoUrl: projectWorkspaceRows[0]?.repoUrl ?? null,
      repoRef: projectWorkspaceRows[0]?.repoRef ?? null,
      workspaceHints,
      warnings,
    };
  }

  const sessionCwd = readNonEmptyString(previousSessionParams?.cwd);
  if (sessionCwd) {
    const sessionCwdExists = await fs
      .stat(sessionCwd)
      .then((stats) => stats.isDirectory())
      .catch(() => false);
    if (sessionCwdExists) {
      return {
        cwd: sessionCwd,
        source: "task_session",
        projectId: resolvedProjectId,
        workspaceId: readNonEmptyString(previousSessionParams?.workspaceId),
        repoUrl: readNonEmptyString(previousSessionParams?.repoUrl),
        repoRef: readNonEmptyString(previousSessionParams?.repoRef),
        workspaceHints,
        warnings: [],
      };
    }
  }

  const cwd = resolveDefaultAgentWorkspaceDir(agent.id);
  await fs.mkdir(cwd, { recursive: true });
  const warnings: string[] = [];
  if (sessionCwd) {
    warnings.push(
      `Saved session workspace "${pathForWorkspaceWarning(sessionCwd)}" is not available. Using fallback workspace "${pathForWorkspaceWarning(cwd)}" for this run.`,
    );
  } else if (resolvedProjectId) {
    warnings.push(
      `No project workspace directory is currently available for this issue. Using fallback workspace "${pathForWorkspaceWarning(cwd)}" for this run.`,
    );
  } else {
    warnings.push(
      `No project or prior session workspace was available. Using fallback workspace "${pathForWorkspaceWarning(cwd)}" for this run.`,
    );
  }
  return {
    cwd,
    source: "agent_home",
    projectId: resolvedProjectId,
    workspaceId: null,
    repoUrl: null,
    repoRef: null,
    workspaceHints,
    warnings,
  };
}
