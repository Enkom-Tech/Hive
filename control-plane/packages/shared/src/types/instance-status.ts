import type { DeploymentExposure, DeploymentMode } from "../constants.js";
import type { WorkloadRecommendationAction } from "./workload.js";

export type InstanceStatusSubsystemState = "ok" | "degraded" | "critical" | "unknown";

export type InstanceStatusMigrationReason =
  | "no-migration-journal-empty-db"
  | "no-migration-journal-non-empty-db"
  | "pending-migrations";

export interface InstanceStatusHealthSnapshot {
  status: "ok";
  deploymentMode: DeploymentMode;
  deploymentExposure: DeploymentExposure;
  authReady: boolean;
  bootstrapStatus: "ready" | "bootstrap_pending";
  bootstrapInviteActive: boolean;
  auth: {
    signUpDisabled: boolean;
  };
  features: {
    companyDeletionEnabled: boolean;
  };
}

/** Migration summary for non-instance-admin board users */
export interface InstanceStatusMigrationSummary {
  status: "upToDate" | "needsMigrations" | "unavailable";
  pending: boolean;
  pendingCount: number;
  reason?: InstanceStatusMigrationReason;
}

/** Full migration detail for instance admins */
export interface InstanceStatusMigrationDetail extends InstanceStatusMigrationSummary {
  tableCount: number;
  availableMigrations: string[];
  appliedMigrations: string[];
  pendingMigrations: string[];
}

export interface InstanceStatusSchedulerSummary {
  totalSchedulers: number;
  activeCount: number;
  staleCount: number;
  /** Seconds since last heartbeat for the stalest active scheduler; null if none */
  maxStalenessSeconds: number | null;
}

export interface InstanceStatusWorkloadRow {
  companyId: string;
  companyName: string;
  action: WorkloadRecommendationAction;
  reason: string;
  details: string[];
}

export interface InstanceStatusResponse {
  timestamp: number;
  appVersion: string;
  releases: {
    currentVersion: string;
    latestVersion?: string;
    releasesUrl?: string;
  };
  subsystems: {
    api: InstanceStatusSubsystemState;
    database: InstanceStatusSubsystemState;
    migrations: InstanceStatusSubsystemState;
    authBootstrap: InstanceStatusSubsystemState;
    schedulers: InstanceStatusSubsystemState;
    workload: InstanceStatusSubsystemState;
  };
  deployment: InstanceStatusHealthSnapshot;
  migration: InstanceStatusMigrationSummary | InstanceStatusMigrationDetail;
  schedulers: InstanceStatusSchedulerSummary;
  prometheus: {
    enabled: boolean;
    scrapePath: string | null;
  };
  /** True when caller may use POST /api/instance/migrations/apply */
  migrationsApplyAllowed: boolean;
  /** Instance admins only: worst workload by company */
  workloadTop?: InstanceStatusWorkloadRow[];
}

export interface InstanceStatusMigrationApplyResponse {
  ok: boolean;
  migration: InstanceStatusMigrationDetail | InstanceStatusMigrationSummary;
}

