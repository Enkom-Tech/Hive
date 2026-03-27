import { createHash, randomBytes } from "node:crypto";
import { and, asc, desc, eq, gt, inArray, isNull, ne, sql } from "drizzle-orm";
import type { Db } from "@hive/db";
import {
  agents,
  companyMemberships,
  agentConfigRevisions,
  agentApiKeys,
  droneProvisioningTokens,
  managedWorkerLinkEnrollmentTokens,
  workerInstanceLinkEnrollmentTokens,
  workerInstanceAgents,
  workerInstances,
  workerIdentityDesiredSlots,
  agentRuntimeState,
  agentTaskSessions,
  agentWakeupRequests,
  heartbeatRunEvents,
  heartbeatRuns,
  runPlacements,
} from "@hive/db";
import {
  isUuidLike,
  normalizeAgentUrlKey,
  type PatchWorkerInstance,
  type CreateWorkerIdentitySlot,
  type PatchWorkerIdentitySlot,
} from "@hive/shared";
import { conflict, notFound, unprocessable } from "../errors.js";
import {
  getConnectedManagedWorkerAgentIdsForCompany,
  isWorkerInstanceConnected,
} from "../workers/worker-link.js";
import { createWorkerAssignmentService } from "./worker-assignment/index.js";
import { reconcileWorkerIdentitySlotsForCompany } from "./worker-identity-reconcile.js";
import { parseDroneFromAgentMetadata } from "../workers/worker-hello.js";
import { normalizeAgentPermissions } from "./agent-permissions.js";
import { REDACTED_EVENT_VALUE, sanitizeRecord } from "../redaction.js";
import { cancelInFlightPlacementsForDrainingWorker } from "./drain-placement-cancel-registry.js";

/** Postgres undefined_column — e.g. `worker_instances` migration 0035 not applied yet. */
function isPgUndefinedColumnError(err: unknown): boolean {
  const walk = (e: unknown): boolean => {
    if (e == null) return false;
    const o = e as { code?: string; message?: string; cause?: unknown };
    if (o.code === "42703") return true;
    if (typeof o.message === "string" && /column .+ does not exist/i.test(o.message)) return true;
    return walk(o.cause);
  };
  return walk(err);
}

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function createToken() {
  return `pcp_${randomBytes(24).toString("hex")}`;
}

function createLinkEnrollmentTokenPlain() {
  return `hive_wen_${randomBytes(24).toString("base64url")}`;
}

function createDroneProvisioningTokenPlain() {
  return `hive_dpv_${randomBytes(24).toString("base64url")}`;
}

const CONFIG_REVISION_FIELDS = [
  "name",
  "role",
  "title",
  "reportsTo",
  "capabilities",
  "adapterType",
  "adapterConfig",
  "runtimeConfig",
  "budgetMonthlyCents",
  "metadata",
] as const;

type ConfigRevisionField = (typeof CONFIG_REVISION_FIELDS)[number];
type AgentConfigSnapshot = Pick<typeof agents.$inferSelect, ConfigRevisionField>;

interface RevisionMetadata {
  createdByAgentId?: string | null;
  createdByUserId?: string | null;
  source?: string;
  rolledBackFromRevisionId?: string | null;
}

interface UpdateAgentOptions {
  recordRevision?: RevisionMetadata;
}

interface AgentShortnameRow {
  id: string;
  name: string;
  status: string;
}

interface AgentShortnameCollisionOptions {
  excludeAgentId?: string | null;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function buildConfigSnapshot(
  row: Pick<typeof agents.$inferSelect, ConfigRevisionField>,
): AgentConfigSnapshot {
  const adapterConfig =
    typeof row.adapterConfig === "object" && row.adapterConfig !== null && !Array.isArray(row.adapterConfig)
      ? sanitizeRecord(row.adapterConfig as Record<string, unknown>)
      : {};
  const runtimeConfig =
    typeof row.runtimeConfig === "object" && row.runtimeConfig !== null && !Array.isArray(row.runtimeConfig)
      ? sanitizeRecord(row.runtimeConfig as Record<string, unknown>)
      : {};
  const metadata =
    typeof row.metadata === "object" && row.metadata !== null && !Array.isArray(row.metadata)
      ? sanitizeRecord(row.metadata as Record<string, unknown>)
      : row.metadata ?? null;
  return {
    name: row.name,
    role: row.role,
    title: row.title,
    reportsTo: row.reportsTo,
    capabilities: row.capabilities,
    adapterType: row.adapterType,
    adapterConfig,
    runtimeConfig,
    budgetMonthlyCents: row.budgetMonthlyCents,
    metadata,
  };
}

function containsRedactedMarker(value: unknown): boolean {
  if (value === REDACTED_EVENT_VALUE) return true;
  if (Array.isArray(value)) return value.some((item) => containsRedactedMarker(item));
  if (typeof value !== "object" || value === null) return false;
  return Object.values(value as Record<string, unknown>).some((entry) => containsRedactedMarker(entry));
}

function hasConfigPatchFields(data: Partial<typeof agents.$inferInsert>) {
  return CONFIG_REVISION_FIELDS.some((field) => Object.prototype.hasOwnProperty.call(data, field));
}

function diffConfigSnapshot(
  before: AgentConfigSnapshot,
  after: AgentConfigSnapshot,
): string[] {
  return CONFIG_REVISION_FIELDS.filter((field) => !jsonEqual(before[field], after[field]));
}

function configPatchFromSnapshot(snapshot: unknown): Partial<typeof agents.$inferInsert> {
  if (!isPlainRecord(snapshot)) throw unprocessable("Invalid revision snapshot");

  if (typeof snapshot.name !== "string" || snapshot.name.length === 0) {
    throw unprocessable("Invalid revision snapshot: name");
  }
  if (typeof snapshot.role !== "string" || snapshot.role.length === 0) {
    throw unprocessable("Invalid revision snapshot: role");
  }
  if (typeof snapshot.adapterType !== "string" || snapshot.adapterType.length === 0) {
    throw unprocessable("Invalid revision snapshot: adapterType");
  }
  if (typeof snapshot.budgetMonthlyCents !== "number" || !Number.isFinite(snapshot.budgetMonthlyCents)) {
    throw unprocessable("Invalid revision snapshot: budgetMonthlyCents");
  }

  return {
    name: snapshot.name,
    role: snapshot.role,
    title: typeof snapshot.title === "string" || snapshot.title === null ? snapshot.title : null,
    reportsTo:
      typeof snapshot.reportsTo === "string" || snapshot.reportsTo === null ? snapshot.reportsTo : null,
    capabilities:
      typeof snapshot.capabilities === "string" || snapshot.capabilities === null
        ? snapshot.capabilities
        : null,
    adapterType: snapshot.adapterType,
    adapterConfig: isPlainRecord(snapshot.adapterConfig) ? snapshot.adapterConfig : {},
    runtimeConfig: isPlainRecord(snapshot.runtimeConfig) ? snapshot.runtimeConfig : {},
    budgetMonthlyCents: Math.max(0, Math.floor(snapshot.budgetMonthlyCents)),
    metadata: isPlainRecord(snapshot.metadata) || snapshot.metadata === null ? snapshot.metadata : null,
  };
}

export function hasAgentShortnameCollision(
  candidateName: string,
  existingAgents: AgentShortnameRow[],
  options?: AgentShortnameCollisionOptions,
): boolean {
  const candidateShortname = normalizeAgentUrlKey(candidateName);
  if (!candidateShortname) return false;

  return existingAgents.some((agent) => {
    if (agent.status === "terminated") return false;
    if (options?.excludeAgentId && agent.id === options.excludeAgentId) return false;
    return normalizeAgentUrlKey(agent.name) === candidateShortname;
  });
}

export function deduplicateAgentName(
  candidateName: string,
  existingAgents: AgentShortnameRow[],
): string {
  if (!hasAgentShortnameCollision(candidateName, existingAgents)) {
    return candidateName;
  }
  for (let i = 2; i <= 100; i++) {
    const suffixed = `${candidateName} ${i}`;
    if (!hasAgentShortnameCollision(suffixed, existingAgents)) {
      return suffixed;
    }
  }
  return `${candidateName} ${Date.now()}`;
}

export function agentService(
  db: Db,
  svcOpts?: {
    drainAutoEvacuateEnabled?: boolean;
    workerIdentityAutomationEnabled?: boolean;
    /** When true (default), marking a worker instance draining cancels queued/running placements on that instance. */
    drainCancelInFlightPlacementsEnabled?: boolean;
  },
) {
  const drainAutoEvacuateEnabled = svcOpts?.drainAutoEvacuateEnabled === true;
  const drainCancelInFlightPlacementsEnabled = svcOpts?.drainCancelInFlightPlacementsEnabled !== false;
  const workerIdentityAutomationEnabled = svcOpts?.workerIdentityAutomationEnabled !== false;
  const workerAssignment = createWorkerAssignmentService(db);

  function withUrlKey<T extends { id: string; name: string }>(row: T) {
    return {
      ...row,
      urlKey: normalizeAgentUrlKey(row.name) ?? row.id,
    };
  }

  function normalizeAgentRow(row: typeof agents.$inferSelect) {
    const { pairingWindowExpiresAt: pairingUntil, ...rest } = row;
    return withUrlKey({
      ...rest,
      pairingWindowExpiresAt: pairingUntil?.toISOString() ?? null,
      permissions: normalizeAgentPermissions(row.permissions, row.role),
    });
  }

  async function getById(id: string) {
    const row = await db
      .select()
      .from(agents)
      .where(eq(agents.id, id))
      .then((rows) => rows[0] ?? null);
    return row ? normalizeAgentRow(row) : null;
  }

  async function ensureManager(companyId: string, managerId: string) {
    const manager = await getById(managerId);
    if (!manager) throw notFound("Manager not found");
    if (manager.companyId !== companyId) {
      throw unprocessable("Manager must belong to same company");
    }
    return manager;
  }

  async function assertNoCycle(agentId: string, reportsTo: string | null | undefined) {
    if (!reportsTo) return;
    if (reportsTo === agentId) throw unprocessable("Agent cannot report to itself");

    let cursor: string | null = reportsTo;
    while (cursor) {
      if (cursor === agentId) throw unprocessable("Reporting relationship would create cycle");
      const next = await getById(cursor);
      cursor = next?.reportsTo ?? null;
    }
  }

  async function assertCompanyShortnameAvailable(
    companyId: string,
    candidateName: string,
    options?: AgentShortnameCollisionOptions,
  ) {
    const candidateShortname = normalizeAgentUrlKey(candidateName);
    if (!candidateShortname) return;

    const existingAgents = await db
      .select({
        id: agents.id,
        name: agents.name,
        status: agents.status,
      })
      .from(agents)
      .where(eq(agents.companyId, companyId));

    const hasCollision = hasAgentShortnameCollision(candidateName, existingAgents, options);
    if (hasCollision) {
      throw conflict(
        `Agent shortname '${candidateShortname}' is already in use in this company`,
      );
    }
  }

  async function updateAgent(
    id: string,
    data: Partial<typeof agents.$inferInsert>,
    options?: UpdateAgentOptions,
  ) {
    const existing = await getById(id);
    if (!existing) return null;

    if (existing.status === "terminated" && data.status && data.status !== "terminated") {
      throw conflict("Terminated agents cannot be resumed");
    }
    if (
      existing.status === "pending_approval" &&
      data.status &&
      data.status !== "pending_approval" &&
      data.status !== "terminated"
    ) {
      throw conflict("Pending approval agents cannot be activated directly");
    }

    if (data.reportsTo !== undefined) {
      if (data.reportsTo) {
        await ensureManager(existing.companyId, data.reportsTo);
      }
      await assertNoCycle(id, data.reportsTo);
    }

    if (data.name !== undefined) {
      const previousShortname = normalizeAgentUrlKey(existing.name);
      const nextShortname = normalizeAgentUrlKey(data.name);
      if (previousShortname !== nextShortname) {
        await assertCompanyShortnameAvailable(existing.companyId, data.name, { excludeAgentId: id });
      }
    }

    const normalizedPatch = { ...data } as Partial<typeof agents.$inferInsert>;
    if (data.permissions !== undefined) {
      const role = (data.role ?? existing.role) as string;
      normalizedPatch.permissions = normalizeAgentPermissions(data.permissions, role);
    }

    const shouldRecordRevision = Boolean(options?.recordRevision) && hasConfigPatchFields(normalizedPatch);
    const beforeConfig = shouldRecordRevision ? buildConfigSnapshot(existing) : null;

    const updated = await db
      .update(agents)
      .set({ ...normalizedPatch, updatedAt: new Date() })
      .where(eq(agents.id, id))
      .returning()
      .then((rows) => rows[0] ?? null);
    const normalizedUpdated = updated ? normalizeAgentRow(updated) : null;

    if (normalizedUpdated && shouldRecordRevision && beforeConfig) {
      const afterConfig = buildConfigSnapshot(normalizedUpdated);
      const changedKeys = diffConfigSnapshot(beforeConfig, afterConfig);
      if (changedKeys.length > 0) {
        await db.insert(agentConfigRevisions).values({
          companyId: normalizedUpdated.companyId,
          agentId: normalizedUpdated.id,
          createdByAgentId: options?.recordRevision?.createdByAgentId ?? null,
          createdByUserId: options?.recordRevision?.createdByUserId ?? null,
          source: options?.recordRevision?.source ?? "patch",
          rolledBackFromRevisionId: options?.recordRevision?.rolledBackFromRevisionId ?? null,
          changedKeys,
          beforeConfig: beforeConfig as unknown as Record<string, unknown>,
          afterConfig: afterConfig as unknown as Record<string, unknown>,
        });
      }
    }

    return normalizedUpdated;
  }

  async function createAgent(companyId: string, data: Omit<typeof agents.$inferInsert, "companyId">) {
    if (data.reportsTo) {
      await ensureManager(companyId, data.reportsTo);
    }

    const existingAgents = await db
      .select({ id: agents.id, name: agents.name, status: agents.status })
      .from(agents)
      .where(eq(agents.companyId, companyId));
    const uniqueName = deduplicateAgentName(data.name, existingAgents);

    const role = data.role ?? "general";
    const normalizedPermissions = normalizeAgentPermissions(data.permissions, role);
    const created = await db
      .insert(agents)
      .values({ ...data, name: uniqueName, companyId, role, permissions: normalizedPermissions })
      .returning()
      .then((rows) => rows[0]);

    await db
      .insert(companyMemberships)
      .values({
        companyId,
        principalType: "agent",
        principalId: created.id,
        status: "active",
        membershipRole: "operator",
      })
      .onConflictDoNothing({
        target: [
          companyMemberships.companyId,
          companyMemberships.principalType,
          companyMemberships.principalId,
        ],
      });

    return normalizeAgentRow(created);
  }

  async function createAgentFromWorkerIdentitySlot(
    companyId: string,
    slot: typeof workerIdentityDesiredSlots.$inferSelect,
  ): Promise<{ id: string }> {
    const row = await createAgent(companyId, {
      name: slot.displayNamePrefix,
      role: slot.role,
      adapterType: "managed_worker",
      adapterConfig: slot.adapterConfig ?? {},
      runtimeConfig: slot.runtimeConfig ?? {},
      workerPlacementMode: slot.workerPlacementMode,
      operationalPosture: slot.operationalPosture,
      workerIdentitySlotId: slot.id,
      metadata: {
        createdBy: "worker_identity_automation",
        workerIdentityProfileKey: slot.profileKey,
      },
    });
    return { id: row.id };
  }

  return {
    list: async (companyId: string, options?: { includeTerminated?: boolean }) => {
      const conditions = [eq(agents.companyId, companyId)];
      if (!options?.includeTerminated) {
        conditions.push(ne(agents.status, "terminated"));
      }
      const rows = await db.select().from(agents).where(and(...conditions));
      return rows.map(normalizeAgentRow);
    },

    getById,

    create: createAgent,

    update: updateAgent,

    pause: async (id: string) => {
      const existing = await getById(id);
      if (!existing) return null;
      if (existing.status === "terminated") throw conflict("Cannot pause terminated agent");

      const updated = await db
        .update(agents)
        .set({ status: "paused", updatedAt: new Date() })
        .where(eq(agents.id, id))
        .returning()
        .then((rows) => rows[0] ?? null);
      return updated ? normalizeAgentRow(updated) : null;
    },

    resume: async (id: string) => {
      const existing = await getById(id);
      if (!existing) return null;
      if (existing.status === "terminated") throw conflict("Cannot resume terminated agent");
      if (existing.status === "pending_approval") {
        throw conflict("Pending approval agents cannot be resumed");
      }

      const updated = await db
        .update(agents)
        .set({ status: "idle", updatedAt: new Date() })
        .where(eq(agents.id, id))
        .returning()
        .then((rows) => rows[0] ?? null);
      return updated ? normalizeAgentRow(updated) : null;
    },

    terminate: async (id: string) => {
      const existing = await getById(id);
      if (!existing) return null;

      await db
        .update(agents)
        .set({ status: "terminated", updatedAt: new Date() })
        .where(eq(agents.id, id));

      await db
        .update(agentApiKeys)
        .set({ revokedAt: new Date() })
        .where(eq(agentApiKeys.agentId, id));

      return getById(id);
    },

    remove: async (id: string) => {
      const existing = await getById(id);
      if (!existing) return null;

      return db.transaction(async (tx) => {
        await tx.update(agents).set({ reportsTo: null }).where(eq(agents.reportsTo, id));
        await tx.delete(heartbeatRunEvents).where(eq(heartbeatRunEvents.agentId, id));
        await tx.delete(agentTaskSessions).where(eq(agentTaskSessions.agentId, id));
        await tx.delete(heartbeatRuns).where(eq(heartbeatRuns.agentId, id));
        await tx.delete(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, id));
        await tx.delete(agentApiKeys).where(eq(agentApiKeys.agentId, id));
        await tx.delete(agentRuntimeState).where(eq(agentRuntimeState.agentId, id));
        const deleted = await tx
          .delete(agents)
          .where(eq(agents.id, id))
          .returning()
          .then((rows) => rows[0] ?? null);
        return deleted ? normalizeAgentRow(deleted) : null;
      });
    },

    activatePendingApproval: async (id: string) => {
      const existing = await getById(id);
      if (!existing) return null;
      if (existing.status !== "pending_approval") return existing;

      const updated = await db
        .update(agents)
        .set({ status: "idle", updatedAt: new Date() })
        .where(eq(agents.id, id))
        .returning()
        .then((rows) => rows[0] ?? null);

      return updated ? normalizeAgentRow(updated) : null;
    },

    updatePermissions: async (id: string, permissions: { canCreateAgents: boolean }) => {
      const existing = await getById(id);
      if (!existing) return null;

      const updated = await db
        .update(agents)
        .set({
          permissions: normalizeAgentPermissions(permissions, existing.role),
          updatedAt: new Date(),
        })
        .where(eq(agents.id, id))
        .returning()
        .then((rows) => rows[0] ?? null);

      return updated ? normalizeAgentRow(updated) : null;
    },

    listConfigRevisions: async (id: string) =>
      db
        .select()
        .from(agentConfigRevisions)
        .where(eq(agentConfigRevisions.agentId, id))
        .orderBy(desc(agentConfigRevisions.createdAt)),

    getConfigRevision: async (id: string, revisionId: string) =>
      db
        .select()
        .from(agentConfigRevisions)
        .where(and(eq(agentConfigRevisions.agentId, id), eq(agentConfigRevisions.id, revisionId)))
        .then((rows) => rows[0] ?? null),

    rollbackConfigRevision: async (
      id: string,
      revisionId: string,
      actor: { agentId?: string | null; userId?: string | null },
    ) => {
      const revision = await db
        .select()
        .from(agentConfigRevisions)
        .where(and(eq(agentConfigRevisions.agentId, id), eq(agentConfigRevisions.id, revisionId)))
        .then((rows) => rows[0] ?? null);
      if (!revision) return null;
      if (containsRedactedMarker(revision.afterConfig)) {
        throw unprocessable("Cannot roll back a revision that contains redacted secret values");
      }

      const patch = configPatchFromSnapshot(revision.afterConfig);
      return updateAgent(id, patch, {
        recordRevision: {
          createdByAgentId: actor.agentId ?? null,
          createdByUserId: actor.userId ?? null,
          source: "rollback",
          rolledBackFromRevisionId: revision.id,
        },
      });
    },

    createApiKey: async (id: string, name: string) => {
      const existing = await getById(id);
      if (!existing) throw notFound("Agent not found");
      if (existing.status === "pending_approval") {
        throw conflict("Cannot create keys for pending approval agents");
      }
      if (existing.status === "terminated") {
        throw conflict("Cannot create keys for terminated agents");
      }

      const token = createToken();
      const keyHash = hashToken(token);
      const created = await db
        .insert(agentApiKeys)
        .values({
          agentId: id,
          companyId: existing.companyId,
          name,
          keyHash,
        })
        .returning()
        .then((rows) => rows[0]);

      return {
        id: created.id,
        name: created.name,
        token,
        createdAt: created.createdAt,
      };
    },

    createWorkerInstanceLinkEnrollmentToken: async (
      companyId: string,
      workerInstanceId: string,
      ttlSeconds: number,
      options?: { maxTtlSeconds?: number },
    ) => {
      const inst = await db
        .select({ id: workerInstances.id })
        .from(workerInstances)
        .where(and(eq(workerInstances.id, workerInstanceId), eq(workerInstances.companyId, companyId)))
        .then((rows) => rows[0] ?? null);
      if (!inst) throw notFound("Worker instance not found");

      const cap = options?.maxTtlSeconds ?? 3600;
      const ttl = Math.min(cap, Math.max(120, Math.floor(ttlSeconds) || 900));
      const token = createLinkEnrollmentTokenPlain();
      const tokenHash = hashToken(token);
      const expiresAt = new Date(Date.now() + ttl * 1000);

      await db.insert(workerInstanceLinkEnrollmentTokens).values({
        workerInstanceId,
        companyId,
        tokenHash,
        expiresAt,
      });

      return { token, expiresAt };
    },

    createDroneProvisioningToken: async (companyId: string, ttlSeconds: number) => {
      const ttl = Math.min(3600, Math.max(120, Math.floor(ttlSeconds) || 900));
      const token = createDroneProvisioningTokenPlain();
      const tokenHash = hashToken(token);
      const expiresAt = new Date(Date.now() + ttl * 1000);

      await db.insert(droneProvisioningTokens).values({
        companyId,
        tokenHash,
        expiresAt,
      });

      return { token, expiresAt };
    },

    bindManagedWorkerAgentToInstance: (companyId: string, workerInstanceId: string, agentId: string) =>
      workerAssignment.bindManagedWorkerAgentToInstance(companyId, workerInstanceId, agentId, "manual"),

    unbindManagedWorkerAgentFromInstance: (companyId: string, agentId: string) =>
      workerAssignment.unbindManagedWorkerAgentFromInstance(companyId, agentId),

    rotateAutomaticWorkerPoolPlacement: (companyId: string, agentId: string) =>
      workerAssignment.rotateAutomaticPlacementToNextDrone(companyId, agentId),

    reconcileWorkerIdentitySlotsForCompany: (companyId: string) =>
      reconcileWorkerIdentitySlotsForCompany(db, companyId, {
        enabled: workerIdentityAutomationEnabled,
        createAgentFromSlot: ({ companyId: cid, slot }) => createAgentFromWorkerIdentitySlot(cid, slot),
      }),

    /** Runs desired-state identity creation, then automatic drone binding (provision hello hook). */
    reconcileAutomationForCompany: async (companyId: string) => {
      const identity = await reconcileWorkerIdentitySlotsForCompany(db, companyId, {
        enabled: workerIdentityAutomationEnabled,
        createAgentFromSlot: ({ companyId: cid, slot }) => createAgentFromWorkerIdentitySlot(cid, slot),
      });
      const placement = await workerAssignment.reconcileAutomaticAssignmentsForCompany(companyId);
      return {
        attempted: placement.attempted,
        assigned: placement.assigned,
        identityAgentsCreated: identity.agentsCreated,
        identitySlotsProcessed: identity.slotsProcessed,
        identityErrors: identity.errors,
      };
    },

    reconcileAutomaticAssignmentsForCompany: (companyId: string) =>
      workerAssignment.reconcileAutomaticAssignmentsForCompany(companyId),

    listWorkerIdentitySlots: async (companyId: string) => {
      return db
        .select()
        .from(workerIdentityDesiredSlots)
        .where(eq(workerIdentityDesiredSlots.companyId, companyId))
        .orderBy(asc(workerIdentityDesiredSlots.profileKey));
    },

    createWorkerIdentitySlot: async (companyId: string, input: CreateWorkerIdentitySlot) => {
      try {
        const [row] = await db
          .insert(workerIdentityDesiredSlots)
          .values({
            companyId,
            profileKey: input.profileKey,
            displayNamePrefix: input.displayNamePrefix,
            desiredCount: input.desiredCount,
            workerPlacementMode: input.workerPlacementMode ?? "automatic",
            operationalPosture: input.operationalPosture ?? "active",
            adapterType: input.adapterType ?? "managed_worker",
            adapterConfig: input.adapterConfig ?? {},
            runtimeConfig: input.runtimeConfig ?? {},
            role: input.role ?? "general",
            enabled: input.enabled ?? true,
          })
          .returning();
        return row;
      } catch (e) {
        if ((e as { code?: string }).code === "23505") {
          throw conflict("profile_key already exists for this company");
        }
        throw e;
      }
    },

    patchWorkerIdentitySlot: async (companyId: string, slotId: string, patch: PatchWorkerIdentitySlot) => {
      const existing = await db
        .select()
        .from(workerIdentityDesiredSlots)
        .where(and(eq(workerIdentityDesiredSlots.id, slotId), eq(workerIdentityDesiredSlots.companyId, companyId)))
        .then((r) => r[0] ?? null);
      if (!existing) throw notFound("Worker identity slot not found");

      const now = new Date();
      const updates: Partial<typeof workerIdentityDesiredSlots.$inferInsert> = { updatedAt: now };
      if (patch.displayNamePrefix !== undefined) updates.displayNamePrefix = patch.displayNamePrefix;
      if (patch.desiredCount !== undefined) updates.desiredCount = patch.desiredCount;
      if (patch.workerPlacementMode !== undefined) updates.workerPlacementMode = patch.workerPlacementMode;
      if (patch.operationalPosture !== undefined) updates.operationalPosture = patch.operationalPosture;
      if (patch.adapterConfig !== undefined) updates.adapterConfig = patch.adapterConfig;
      if (patch.runtimeConfig !== undefined) updates.runtimeConfig = patch.runtimeConfig;
      if (patch.role !== undefined) updates.role = patch.role;
      if (patch.enabled !== undefined) updates.enabled = patch.enabled;

      const [updated] = await db
        .update(workerIdentityDesiredSlots)
        .set(updates)
        .where(eq(workerIdentityDesiredSlots.id, slotId))
        .returning();
      return updated;
    },

    deleteWorkerIdentitySlot: async (companyId: string, slotId: string) => {
      const existing = await db
        .select()
        .from(workerIdentityDesiredSlots)
        .where(and(eq(workerIdentityDesiredSlots.id, slotId), eq(workerIdentityDesiredSlots.companyId, companyId)))
        .then((r) => r[0] ?? null);
      if (!existing) throw notFound("Worker identity slot not found");

      const countRows = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(agents)
        .where(and(eq(agents.workerIdentitySlotId, slotId), ne(agents.status, "terminated")));
      if (Number(countRows[0]?.count ?? 0) > 0) {
        throw conflict(
          "Cannot delete slot while non-terminated agents reference it; terminate or reassign them first",
        );
      }

      await db.delete(workerIdentityDesiredSlots).where(eq(workerIdentityDesiredSlots.id, slotId));
    },

    getWorkerIdentityAutomationStatus: async (companyId: string) => {
      const slots = await db
        .select()
        .from(workerIdentityDesiredSlots)
        .where(eq(workerIdentityDesiredSlots.companyId, companyId))
        .orderBy(asc(workerIdentityDesiredSlots.profileKey));

      const slotsWithCounts = await Promise.all(
        slots.map(async (slot) => {
          const crows = await db
            .select({ count: sql<number>`count(*)::int` })
            .from(agents)
            .where(and(eq(agents.workerIdentitySlotId, slot.id), ne(agents.status, "terminated")));
          return {
            ...slot,
            currentAgentCount: Number(crows[0]?.count ?? 0),
          };
        }),
      );

      const unbound = await db
        .select({ agentId: agents.id })
        .from(agents)
        .leftJoin(workerInstanceAgents, eq(workerInstanceAgents.agentId, agents.id))
        .where(
          and(
            eq(agents.companyId, companyId),
            eq(agents.adapterType, "managed_worker"),
            eq(agents.workerPlacementMode, "automatic"),
            ne(agents.status, "terminated"),
            ne(agents.operationalPosture, "archived"),
            ne(agents.operationalPosture, "hibernate"),
            isNull(workerInstanceAgents.agentId),
          ),
        );

      return {
        identityAutomationEnabled: workerIdentityAutomationEnabled,
        slots: slotsWithCounts,
        unboundAutomaticAgentIds: unbound.map((r) => r.agentId),
      };
    },

    deleteWorkerInstance: async (companyId: string, workerInstanceId: string) => {
      const inst = await db
        .select({ id: workerInstances.id })
        .from(workerInstances)
        .where(and(eq(workerInstances.id, workerInstanceId), eq(workerInstances.companyId, companyId)))
        .then((rows) => rows[0] ?? null);
      if (!inst) throw notFound("Worker instance not found");

      await db.delete(runPlacements).where(eq(runPlacements.workerInstanceId, workerInstanceId));
      await db.delete(workerInstances).where(eq(workerInstances.id, workerInstanceId));
    },

    patchWorkerInstance: async (
      companyId: string,
      workerInstanceId: string,
      patch: PatchWorkerInstance,
    ) => {
      const inst = await db
        .select()
        .from(workerInstances)
        .where(and(eq(workerInstances.id, workerInstanceId), eq(workerInstances.companyId, companyId)))
        .then((rows) => rows[0] ?? null);
      if (!inst) throw notFound("Worker instance not found");

      const wasDraining = inst.drainRequestedAt != null;
      const now = new Date();
      const updates: Partial<typeof workerInstances.$inferInsert> = { updatedAt: now };

      if (patch.labels !== undefined) {
        updates.labels = patch.labels;
      }
      if (patch.capacityHint !== undefined) {
        updates.capacityHint = patch.capacityHint;
      }
      if (patch.displayLabel !== undefined) {
        updates.displayLabel = patch.displayLabel;
      }

      let nowDraining = wasDraining;
      if (patch.drainRequested === true) {
        updates.drainRequestedAt = now;
        nowDraining = true;
      } else if (patch.drainRequested === false) {
        updates.drainRequestedAt = null;
        nowDraining = false;
      }

      await db.update(workerInstances).set(updates).where(eq(workerInstances.id, workerInstanceId));

      let drainEvacuation: { evacuatedAgentIds: string[]; skippedAgentIds: string[] } | undefined;
      if (!wasDraining && nowDraining && drainCancelInFlightPlacementsEnabled) {
        await cancelInFlightPlacementsForDrainingWorker(db, workerInstanceId);
      }
      if (!wasDraining && nowDraining && drainAutoEvacuateEnabled) {
        drainEvacuation = await workerAssignment.evacuateAutomaticAgentsOffDrainingInstance(
          companyId,
          workerInstanceId,
        );
      }

      const fresh = await db
        .select()
        .from(workerInstances)
        .where(eq(workerInstances.id, workerInstanceId))
        .then((rows) => rows[0] ?? null);
      if (!fresh) throw notFound("Worker instance not found");

      return {
        id: fresh.id,
        stableInstanceId: fresh.stableInstanceId,
        labels: (typeof fresh.labels === "object" && fresh.labels !== null && !Array.isArray(fresh.labels)
          ? fresh.labels
          : {}) as Record<string, unknown>,
        drainRequestedAt: fresh.drainRequestedAt?.toISOString() ?? null,
        capacityHint: fresh.capacityHint ?? null,
        displayLabel: fresh.displayLabel ?? null,
        updatedAt: fresh.updatedAt.toISOString(),
        drainEvacuation,
      };
    },

    createLinkEnrollmentToken: async (id: string, ttlSeconds: number) => {
      const existing = await getById(id);
      if (!existing) throw notFound("Agent not found");
      if (existing.status === "pending_approval") {
        throw conflict("Cannot create enrollment tokens for pending approval agents");
      }
      if (existing.status === "terminated") {
        throw conflict("Cannot create enrollment tokens for terminated agents");
      }

      const ttl = Math.min(3600, Math.max(120, Math.floor(ttlSeconds) || 900));
      const token = createLinkEnrollmentTokenPlain();
      const tokenHash = hashToken(token);
      const expiresAt = new Date(Date.now() + ttl * 1000);

      await db.insert(managedWorkerLinkEnrollmentTokens).values({
        agentId: id,
        companyId: existing.companyId,
        tokenHash,
        expiresAt,
      });

      return { token, expiresAt };
    },

    listKeys: (id: string) =>
      db
        .select({
          id: agentApiKeys.id,
          name: agentApiKeys.name,
          createdAt: agentApiKeys.createdAt,
          revokedAt: agentApiKeys.revokedAt,
        })
        .from(agentApiKeys)
        .where(eq(agentApiKeys.agentId, id)),

    revokeKey: async (keyId: string) => {
      const rows = await db
        .update(agentApiKeys)
        .set({ revokedAt: new Date() })
        .where(eq(agentApiKeys.id, keyId))
        .returning();
      return rows[0] ?? null;
    },

    orgForCompany: async (companyId: string) => {
      const rows = await db
        .select()
        .from(agents)
        .where(and(eq(agents.companyId, companyId), ne(agents.status, "terminated")));
      const normalizedRows = rows.map(normalizeAgentRow);
      const byManager = new Map<string | null, typeof normalizedRows>();
      for (const row of normalizedRows) {
        const key = row.reportsTo ?? null;
        const group = byManager.get(key) ?? [];
        group.push(row);
        byManager.set(key, group);
      }

      const build = (managerId: string | null): Array<Record<string, unknown>> => {
        const members = byManager.get(managerId) ?? [];
        return members.map((member) => ({
          ...member,
          reports: build(member.id),
        }));
      };

      return build(null);
    },

    getChainOfCommand: async (agentId: string) => {
      const chain: { id: string; name: string; role: string; title: string | null }[] = [];
      const visited = new Set<string>([agentId]);
      const start = await getById(agentId);
      let currentId = start?.reportsTo ?? null;
      while (currentId && !visited.has(currentId) && chain.length < 50) {
        visited.add(currentId);
        const mgr = await getById(currentId);
        if (!mgr) break;
        chain.push({ id: mgr.id, name: mgr.name, role: mgr.role, title: mgr.title ?? null });
        currentId = mgr.reportsTo ?? null;
      }
      return chain;
    },

    runningForAgent: (agentId: string) =>
      db
        .select()
        .from(heartbeatRuns)
        .where(and(eq(heartbeatRuns.agentId, agentId), inArray(heartbeatRuns.status, ["queued", "running"]))),

    resolveByReference: async (companyId: string, reference: string) => {
      const raw = reference.trim();
      if (raw.length === 0) {
        return { agent: null, ambiguous: false } as const;
      }

      if (isUuidLike(raw)) {
        const byId = await getById(raw);
        if (!byId || byId.companyId !== companyId) {
          return { agent: null, ambiguous: false } as const;
        }
        return { agent: byId, ambiguous: false } as const;
      }

      const urlKey = normalizeAgentUrlKey(raw);
      if (!urlKey) {
        return { agent: null, ambiguous: false } as const;
      }

      const rows = await db.select().from(agents).where(eq(agents.companyId, companyId));
      const matches = rows
        .map(normalizeAgentRow)
        .filter((agent) => agent.urlKey === urlKey && agent.status !== "terminated");
      if (matches.length === 1) {
        return { agent: matches[0] ?? null, ambiguous: false } as const;
      }
      if (matches.length > 1) {
        return { agent: null, ambiguous: true } as const;
      }
      return { agent: null, ambiguous: false } as const;
    },

    listDroneBoardAgentOverview: async (companyId: string) => {
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
        lastHeartbeatAt: a.lastHeartbeatAt ? a.lastHeartbeatAt.toISOString() : null,
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
    },
  };
}
