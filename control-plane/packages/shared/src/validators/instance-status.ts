import { z } from "zod";
import { DEPLOYMENT_EXPOSURES, DEPLOYMENT_MODES } from "../constants.js";

const subsystemStateSchema = z.enum(["ok", "degraded", "critical", "unknown"]);

const migrationReasonSchema = z.enum([
  "no-migration-journal-empty-db",
  "no-migration-journal-non-empty-db",
  "pending-migrations",
]);

const migrationSummarySchema = z.object({
  status: z.enum(["upToDate", "needsMigrations", "unavailable"]),
  pending: z.boolean(),
  pendingCount: z.number().int().nonnegative(),
  reason: migrationReasonSchema.optional(),
});

const migrationDetailSchema = migrationSummarySchema.extend({
  tableCount: z.number().int().nonnegative(),
  availableMigrations: z.array(z.string()),
  appliedMigrations: z.array(z.string()),
  pendingMigrations: z.array(z.string()),
});

const healthSnapshotSchema = z.object({
  status: z.literal("ok"),
  deploymentMode: z.enum(DEPLOYMENT_MODES),
  deploymentExposure: z.enum(DEPLOYMENT_EXPOSURES),
  authReady: z.boolean(),
  bootstrapStatus: z.enum(["ready", "bootstrap_pending"]),
  bootstrapInviteActive: z.boolean(),
  auth: z.object({ signUpDisabled: z.boolean() }),
  features: z.object({ companyDeletionEnabled: z.boolean() }),
});

export const instanceStatusResponseSchema = z.object({
  timestamp: z.number(),
  appVersion: z.string(),
  releases: z.object({
    currentVersion: z.string(),
    latestVersion: z.string().optional(),
    releasesUrl: z.string().optional(),
  }),
  subsystems: z.object({
    api: subsystemStateSchema,
    database: subsystemStateSchema,
    migrations: subsystemStateSchema,
    authBootstrap: subsystemStateSchema,
    schedulers: subsystemStateSchema,
    workload: subsystemStateSchema,
  }),
  deployment: healthSnapshotSchema,
  migration: z.union([migrationSummarySchema, migrationDetailSchema]),
  schedulers: z.object({
    totalSchedulers: z.number().int().nonnegative(),
    activeCount: z.number().int().nonnegative(),
    staleCount: z.number().int().nonnegative(),
    maxStalenessSeconds: z.number().nonnegative().nullable(),
  }),
  prometheus: z.object({
    enabled: z.boolean(),
    scrapePath: z.string().nullable(),
  }),
  migrationsApplyAllowed: z.boolean(),
  workloadTop: z
    .array(
      z.object({
        companyId: z.string().uuid(),
        companyName: z.string(),
        action: z.enum(["normal", "throttle", "shed", "pause"]),
        reason: z.string(),
        details: z.array(z.string()),
      }),
    )
    .optional(),
});

export type InstanceStatusResponseParsed = z.infer<typeof instanceStatusResponseSchema>;
