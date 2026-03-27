import { z } from "zod";
import {
  AGENT_ICON_NAMES,
  AGENT_ROLES,
  AGENT_STATUSES,
  AGENT_RUNTIME_DEFAULT_MODEL_SLUG_KEY,
  IDENTITY_SELF_TUNE_POLICIES,
} from "../constants.js";
import { envConfigSchema } from "./secret.js";

export const agentPermissionsSchema = z.object({
  canCreateAgents: z.boolean().optional().default(false),
});

const adapterConfigSchema = z.record(z.string(), z.unknown()).superRefine((value, ctx) => {
  const envValue = value.env;
  if (envValue === undefined) return;
  const parsed = envConfigSchema.safeParse(envValue);
  if (!parsed.success) {
    ctx.issues.push({
      code: z.ZodIssueCode.custom,
      input: envValue,
      message: "adapterConfig.env must be a map of valid env bindings",
      path: ["env"],
    });
  }
});

export const createAgentSchema = z.object({
  name: z.string().min(1),
  role: z.enum(AGENT_ROLES).optional().default("general"),
  title: z.string().optional().nullable(),
  icon: z.enum(AGENT_ICON_NAMES).optional().nullable(),
  reportsTo: z.string().uuid().optional().nullable(),
  capabilities: z.string().optional().nullable(),
  adapterType: z.string().min(1).max(64).optional().default("managed_worker"),
  adapterConfig: adapterConfigSchema.optional().default({}),
  runtimeConfig: z.record(z.string(), z.unknown()).optional().default({}),
  budgetMonthlyCents: z.number().int().nonnegative().optional().default(0),
  permissions: agentPermissionsSchema.optional(),
  metadata: z.record(z.string(), z.unknown()).optional().nullable(),
});

export type CreateAgent = z.infer<typeof createAgentSchema>;

export const createAgentHireSchema = createAgentSchema.extend({
  sourceIssueId: z.string().uuid().optional().nullable(),
  sourceIssueIds: z.array(z.string().uuid()).optional(),
});

export type CreateAgentHire = z.infer<typeof createAgentHireSchema>;

export const updateAgentSchema = createAgentSchema
  .omit({ permissions: true })
  .partial()
  .extend({
    permissions: z.never().optional(),
    status: z.enum(AGENT_STATUSES).optional(),
    spentMonthlyCents: z.number().int().nonnegative().optional(),
    // PATCH keeps existing adapterType when client omits it
    adapterType: z.string().min(1).max(64).optional(),
    /** manual | automatic — control plane may pick a drone when unassigned (requires HIVE_AUTO_PLACEMENT_ENABLED). */
    workerPlacementMode: z.enum(["manual", "automatic"]).optional(),
    /** Lifecycle / isolation posture for managed_worker scheduling (ADR 005). */
    operationalPosture: z.enum(["active", "archived", "hibernate", "sandbox"]).optional(),
    /** Sets `runtime_config.defaultModelSlug` for model-gateway routing when run context omits model. */
    defaultModelSlug: z.string().min(1).max(512).nullable().optional(),
    identitySelfTunePolicy: z.enum(IDENTITY_SELF_TUNE_POLICIES).nullable().optional(),
  })
  .superRefine((data, ctx) => {
    if (data.runtimeConfig && AGENT_RUNTIME_DEFAULT_MODEL_SLUG_KEY in data.runtimeConfig) {
      const v = (data.runtimeConfig as Record<string, unknown>)[AGENT_RUNTIME_DEFAULT_MODEL_SLUG_KEY];
      if (v !== undefined && v !== null && typeof v !== "string") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `runtime_config.${AGENT_RUNTIME_DEFAULT_MODEL_SLUG_KEY} must be a string or null`,
          path: ["runtimeConfig", AGENT_RUNTIME_DEFAULT_MODEL_SLUG_KEY],
        });
      }
    }
  });

export type UpdateAgent = z.infer<typeof updateAgentSchema>;

export const updateAgentInstructionsPathSchema = z.object({
  path: z.string().trim().min(1).nullable(),
  adapterConfigKey: z.string().trim().min(1).optional(),
});

export type UpdateAgentInstructionsPath = z.infer<typeof updateAgentInstructionsPathSchema>;

export const createAgentKeySchema = z.object({
  name: z.string().min(1).default("default"),
});

export type CreateAgentKey = z.infer<typeof createAgentKeySchema>;

/** Board-only: mint a single-use worker WebSocket enrollment secret (short TTL). */
export const mintWorkerEnrollmentTokenSchema = z.object({
  ttlSeconds: z.coerce.number().int().min(120).max(3600).optional().default(900),
});

export type MintWorkerEnrollmentToken = z.infer<typeof mintWorkerEnrollmentTokenSchema>;

/** Board-only: update drone row metadata / drain flag (Phase C — ADR 005). */
export const patchWorkerInstanceSchema = z
  .object({
    drainRequested: z.boolean().optional(),
    labels: z.record(z.string(), z.unknown()).optional(),
    capacityHint: z.union([z.string().max(2000), z.null()]).optional(),
    displayLabel: z.union([z.string().max(500), z.null()]).optional(),
  })
  .refine((o) => Object.keys(o).length > 0, { message: "At least one field is required" });

export type PatchWorkerInstance = z.infer<typeof patchWorkerInstanceSchema>;

/** Opens a time window where workers can request pairing without a pre-minted enrollment token. */
export const openWorkerPairingWindowSchema = z.object({
  ttlSeconds: z.coerce.number().int().min(120).max(3600).optional().default(900),
});

export type OpenWorkerPairingWindow = z.infer<typeof openWorkerPairingWindowSchema>;

/** Anonymous: start a pairing handshake (only if the agent pairing window is open). */
export const createWorkerPairingRequestSchema = z.object({
  agentId: z.string().uuid(),
  clientInfo: z.record(z.string(), z.unknown()).optional(),
});

export type CreateWorkerPairingRequest = z.infer<typeof createWorkerPairingRequestSchema>;

export const wakeAgentSchema = z.object({
  source: z.enum(["timer", "assignment", "on_demand", "automation"]).optional().default("on_demand"),
  triggerDetail: z.enum(["manual", "ping", "callback", "system", "external_agent_checkout"]).optional(),
  reason: z.string().optional().nullable(),
  payload: z.record(z.string(), z.unknown()).optional().nullable(),
  idempotencyKey: z.string().optional().nullable(),
});

export type WakeAgent = z.infer<typeof wakeAgentSchema>;

export const resetAgentSessionSchema = z.object({
  taskKey: z.string().min(1).optional().nullable(),
});

export type ResetAgentSession = z.infer<typeof resetAgentSessionSchema>;

export const testAdapterEnvironmentSchema = z.object({
  adapterConfig: adapterConfigSchema.optional().default({}),
});

export type TestAdapterEnvironment = z.infer<typeof testAdapterEnvironmentSchema>;

export const updateAgentPermissionsSchema = z.object({
  canCreateAgents: z.boolean(),
});

export type UpdateAgentPermissions = z.infer<typeof updateAgentPermissionsSchema>;
