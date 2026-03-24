export const COMPANY_STATUSES = ["active", "paused", "archived"] as const;
export type CompanyStatus = (typeof COMPANY_STATUSES)[number];

export const DEPLOYMENT_MODES = ["local_trusted", "authenticated"] as const;
export type DeploymentMode = (typeof DEPLOYMENT_MODES)[number];

export const DEPLOYMENT_EXPOSURES = ["private", "public"] as const;
export type DeploymentExposure = (typeof DEPLOYMENT_EXPOSURES)[number];

export const AUTH_BASE_URL_MODES = ["auto", "explicit"] as const;
export type AuthBaseUrlMode = (typeof AUTH_BASE_URL_MODES)[number];

export const AGENT_STATUSES = [
  "active",
  "paused",
  "idle",
  "running",
  "error",
  "pending_approval",
  "terminated",
] as const;
export type AgentStatus = (typeof AGENT_STATUSES)[number];

/**
 * Adapter types supported by the control plane. Only managed_worker is supported.
 * Server registry defines runtime allowed types.
 */
export const AGENT_ADAPTER_TYPES = ["managed_worker"] as const;
export type AgentAdapterType = (typeof AGENT_ADAPTER_TYPES)[number];

/**
 * @deprecated Use GET /api/companies/:companyId/adapters for runtime list. Fallback for UI when API is unavailable.
 */
export function getDefaultAdapterTypesForUI(): readonly string[] {
  return AGENT_ADAPTER_TYPES;
}

export const AGENT_ROLES = [
  "ceo",
  "cto",
  "cmo",
  "cfo",
  "engineer",
  "designer",
  "pm",
  "qa",
  "devops",
  "researcher",
  "general",
] as const;
export type AgentRole = (typeof AGENT_ROLES)[number];

export const AGENT_ROLE_LABELS: Record<AgentRole, string> = {
  ceo: "CEO",
  cto: "CTO",
  cmo: "CMO",
  cfo: "CFO",
  engineer: "Engineer",
  designer: "Designer",
  pm: "PM",
  qa: "QA",
  devops: "DevOps",
  researcher: "Researcher",
  general: "General",
};

export const AGENT_ICON_NAMES = [
  "bot",
  "cpu",
  "brain",
  "zap",
  "rocket",
  "code",
  "terminal",
  "shield",
  "eye",
  "search",
  "wrench",
  "hammer",
  "lightbulb",
  "sparkles",
  "star",
  "heart",
  "flame",
  "bug",
  "cog",
  "database",
  "globe",
  "lock",
  "mail",
  "message-square",
  "file-code",
  "git-branch",
  "package",
  "puzzle",
  "target",
  "wand",
  "atom",
  "circuit-board",
  "radar",
  "swords",
  "telescope",
  "microscope",
  "crown",
  "gem",
  "hexagon",
  "pentagon",
  "fingerprint",
] as const;
export type AgentIconName = (typeof AGENT_ICON_NAMES)[number];

export const ISSUE_STATUSES = [
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "quality_review",
  "done",
  "blocked",
  "cancelled",
] as const;
export type IssueStatus = (typeof ISSUE_STATUSES)[number];

export const ISSUE_PRIORITIES = ["critical", "high", "medium", "low"] as const;
export type IssuePriority = (typeof ISSUE_PRIORITIES)[number];

/** Canonical column/sort order for Kanban, list, and charts (workflow order). */
export const ISSUE_STATUS_ORDER: readonly IssueStatus[] = [
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "quality_review",
  "blocked",
  "done",
  "cancelled",
];

/** Statuses that mean the issue is closed (reopen / is-closed logic). */
export const ISSUE_STATUSES_CLOSED: readonly IssueStatus[] = ["done", "cancelled"];

/** Statuses for which an agent can receive work via webhook. */
export const ISSUE_STATUSES_WORKABLE_FOR_WEBHOOK: readonly IssueStatus[] = ["todo", "in_progress"];

/** All statuses except done/cancelled (open / pending workload). */
export const ISSUE_STATUSES_PENDING: readonly IssueStatus[] = [
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "quality_review",
  "blocked",
];

/** Backlog and todo only (e.g. unstarted queue). */
export const ISSUE_STATUSES_BACKLOG_TODO: readonly IssueStatus[] = ["backlog", "todo"];

/** Display labels for issue statuses. */
export const ISSUE_STATUS_LABELS: Record<IssueStatus, string> = {
  backlog: "Backlog",
  todo: "To Do",
  in_progress: "In Progress",
  in_review: "In Review",
  quality_review: "Quality Review",
  done: "Done",
  blocked: "Blocked",
  cancelled: "Cancelled",
};

/** Priority order for list/chart sort (same as ISSUE_PRIORITIES). */
export const ISSUE_PRIORITY_ORDER = ISSUE_PRIORITIES;

/** Single-status constants for comparisons (avoids literals in server/UI). */
export const ISSUE_STATUS_BACKLOG: IssueStatus = "backlog";
export const ISSUE_STATUS_TODO: IssueStatus = "todo";
export const ISSUE_STATUS_IN_PROGRESS: IssueStatus = "in_progress";
export const ISSUE_STATUS_IN_REVIEW: IssueStatus = "in_review";
export const ISSUE_STATUS_QUALITY_REVIEW: IssueStatus = "quality_review";
export const ISSUE_STATUS_DONE: IssueStatus = "done";
export const ISSUE_STATUS_BLOCKED: IssueStatus = "blocked";
export const ISSUE_STATUS_CANCELLED: IssueStatus = "cancelled";

/** Statuses included in inbox view (all except cancelled). */
export const ISSUE_STATUSES_INBOX: readonly IssueStatus[] = ISSUE_STATUS_ORDER.filter(
  (s) => s !== ISSUE_STATUS_CANCELLED,
);

export const GOAL_LEVELS = ["company", "team", "agent", "task"] as const;
export type GoalLevel = (typeof GOAL_LEVELS)[number];

export const GOAL_STATUSES = ["planned", "active", "achieved", "cancelled"] as const;
export type GoalStatus = (typeof GOAL_STATUSES)[number];

export const PROJECT_STATUSES = [
  "backlog",
  "planned",
  "in_progress",
  "completed",
  "cancelled",
] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export const PROJECT_COLORS = [
  "#6366f1", // indigo
  "#8b5cf6", // violet
  "#ec4899", // pink
  "#ef4444", // red
  "#f97316", // orange
  "#eab308", // yellow
  "#22c55e", // green
  "#14b8a6", // teal
  "#06b6d4", // cyan
  "#3b82f6", // blue
] as const;

export const APPROVAL_TYPES = ["hire_agent", "approve_ceo_strategy", "quality_review"] as const;
export type ApprovalType = (typeof APPROVAL_TYPES)[number];

export const APPROVAL_STATUSES = [
  "pending",
  "revision_requested",
  "approved",
  "rejected",
  "cancelled",
] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

export const SECRET_PROVIDERS = [
  "local_encrypted",
  "aws_secrets_manager",
  "gcp_secret_manager",
  "vault",
] as const;
export type SecretProvider = (typeof SECRET_PROVIDERS)[number];

export const STORAGE_PROVIDERS = ["local_disk", "s3"] as const;
export type StorageProvider = (typeof STORAGE_PROVIDERS)[number];

export const HEARTBEAT_INVOCATION_SOURCES = [
  "timer",
  "assignment",
  "on_demand",
  "automation",
] as const;
export type HeartbeatInvocationSource = (typeof HEARTBEAT_INVOCATION_SOURCES)[number];

export const WAKEUP_TRIGGER_DETAILS = ["manual", "ping", "callback", "system", "external_agent_checkout"] as const;
export type WakeupTriggerDetail = (typeof WAKEUP_TRIGGER_DETAILS)[number];

export const WAKEUP_REQUEST_STATUSES = [
  "queued",
  "deferred_issue_execution",
  "claimed",
  "coalesced",
  "skipped",
  "completed",
  "failed",
  "cancelled",
] as const;
export type WakeupRequestStatus = (typeof WAKEUP_REQUEST_STATUSES)[number];

export const HEARTBEAT_RUN_STATUSES = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
] as const;
export type HeartbeatRunStatus = (typeof HEARTBEAT_RUN_STATUSES)[number];

export const LIVE_EVENT_TYPES = [
  "heartbeat.run.queued",
  "heartbeat.run.status",
  "heartbeat.run.event",
  "heartbeat.run.log",
  "agent.status",
  "activity.logged",
  "worker.pairing.pending",
  /** Drone registered or re-hello after drone-first provision (not the pairing flow). */
  "worker.drone.registered",
  /** Instance or agent enrollment WebSocket opened on this API process. */
  "worker.link.connected",
  /** Worker link WebSocket closed on this API process. */
  "worker.link.disconnected",
  "intent.created",
  "intent.folded",
  "intent.closed",
] as const;
export type LiveEventType = (typeof LIVE_EVENT_TYPES)[number];

/** Intent folding: source of the request (who produced it). */
export const INTENT_SOURCES = ["board", "agent", "api"] as const;
export type IntentSource = (typeof INTENT_SOURCES)[number];

/** Intent folding: classification of the intent. */
export const INTENT_TYPES = ["create_issue", "update_goal", "ops_action"] as const;
export type IntentType = (typeof INTENT_TYPES)[number];

/** Intent folding: lifecycle state of the intent. */
export const INTENT_STATES = ["open", "folded", "closed", "rejected"] as const;
export type IntentState = (typeof INTENT_STATES)[number];

/** Intent folding: how a linked entity relates to the intent. */
export const INTENT_LINK_TYPES = ["primary", "duplicate", "related"] as const;
export type IntentLinkType = (typeof INTENT_LINK_TYPES)[number];

/** Intent folding: entity types that can be linked to an intent. */
export const INTENT_ENTITY_TYPES = ["issue", "goal", "project", "heartbeat_run"] as const;
export type IntentEntityType = (typeof INTENT_ENTITY_TYPES)[number];

/** Max number of items kept in the in-memory live feed (oldest dropped when over). */
export const LIVE_FEED_MAX_ITEMS = 100;

/** Number of activity log entries to fetch when hydrating the feed on first open. */
export const LIVE_FEED_HYDRATE_LIMIT = 50;

/** Terminal run statuses shown in the feed (queued/running are optional). */
export const LIVE_FEED_TERMINAL_RUN_STATUSES = [
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
] as const;
export type LiveFeedTerminalRunStatus = (typeof LIVE_FEED_TERMINAL_RUN_STATUSES)[number];

export const PRINCIPAL_TYPES = ["user", "agent"] as const;
export type PrincipalType = (typeof PRINCIPAL_TYPES)[number];

export const MEMBERSHIP_STATUSES = ["pending", "active", "suspended"] as const;
export type MembershipStatus = (typeof MEMBERSHIP_STATUSES)[number];

export const DEPARTMENT_STATUSES = ["active", "archived"] as const;
export type DepartmentStatus = (typeof DEPARTMENT_STATUSES)[number];

export const INSTANCE_USER_ROLES = ["instance_admin"] as const;
export type InstanceUserRole = (typeof INSTANCE_USER_ROLES)[number];

export const INVITE_TYPES = ["company_join", "bootstrap_ceo"] as const;
export type InviteType = (typeof INVITE_TYPES)[number];

export const INVITE_JOIN_TYPES = ["human", "agent", "both"] as const;
export type InviteJoinType = (typeof INVITE_JOIN_TYPES)[number];

export const JOIN_REQUEST_TYPES = ["human", "agent"] as const;
export type JoinRequestType = (typeof JOIN_REQUEST_TYPES)[number];

export const JOIN_REQUEST_STATUSES = ["pending_approval", "approved", "rejected"] as const;
export type JoinRequestStatus = (typeof JOIN_REQUEST_STATUSES)[number];

export const AUTH_PROVIDERS = ["builtin", "logto"] as const;
export type AuthProvider = (typeof AUTH_PROVIDERS)[number];

export const PERMISSION_KEYS = [
  "agents:create",
  "users:invite",
  "users:manage_permissions",
  "departments:manage",
  "departments:assign_members",
  "tasks:assign",
  "tasks:assign_scope",
  "joins:approve",
] as const;
export type PermissionKey = (typeof PERMISSION_KEYS)[number];
