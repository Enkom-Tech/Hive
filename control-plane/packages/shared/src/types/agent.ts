import type {
  AgentAdapterType,
  AgentRole,
  AgentStatus,
} from "../constants.js";

export interface AgentPermissions {
  canCreateAgents: boolean;
}

export interface Agent {
  id: string;
  companyId: string;
  name: string;
  urlKey: string;
  role: AgentRole;
  title: string | null;
  icon: string | null;
  status: AgentStatus;
  reportsTo: string | null;
  capabilities: string | null;
  adapterType: AgentAdapterType;
  adapterConfig: Record<string, unknown>;
  runtimeConfig: Record<string, unknown>;
  budgetMonthlyCents: number;
  spentMonthlyCents: number;
  permissions: AgentPermissions;
  lastHeartbeatAt: Date | null;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
  /** Present when returned from API as ISO string (worker pairing UX). */
  pairingWindowExpiresAt?: string | null;
  /** manual | automatic — server may pick a drone when unassigned (HIVE_AUTO_PLACEMENT_ENABLED). */
  workerPlacementMode?: string;
  /** active | archived | hibernate | sandbox — scheduling gates (ADR 005). */
  operationalPosture?: string;
}

export interface AgentKeyCreated {
  id: string;
  name: string;
  token: string;
  createdAt: Date;
}

export interface AgentConfigRevision {
  id: string;
  companyId: string;
  agentId: string;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  source: string;
  rolledBackFromRevisionId: string | null;
  changedKeys: string[];
  beforeConfig: Record<string, unknown>;
  afterConfig: Record<string, unknown>;
  createdAt: Date;
}

export type AdapterEnvironmentCheckLevel = "info" | "warn" | "error";
export type AdapterEnvironmentTestStatus = "pass" | "warn" | "fail";

export interface AdapterEnvironmentCheck {
  code: string;
  level: AdapterEnvironmentCheckLevel;
  message: string;
  detail?: string | null;
  hint?: string | null;
}

export interface AdapterEnvironmentTestResult {
  adapterType: string;
  status: AdapterEnvironmentTestStatus;
  checks: AdapterEnvironmentCheck[];
  testedAt: string;
}
