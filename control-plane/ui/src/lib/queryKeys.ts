export const queryKeys = {
  companies: {
    all: ["companies"] as const,
    detail: (id: string) => ["companies", id] as const,
    stats: ["companies", "stats"] as const,
  },
  agents: {
    list: (companyId: string) => ["agents", companyId] as const,
    detail: (id: string) => ["agents", "detail", id] as const,
    runtimeState: (id: string) => ["agents", "runtime-state", id] as const,
    taskSessions: (id: string) => ["agents", "task-sessions", id] as const,
    keys: (agentId: string) => ["agents", "keys", agentId] as const,
    workerConnection: (agentId: string) => ["agents", "worker-connection", agentId] as const,
    configRevisions: (agentId: string) => ["agents", "config-revisions", agentId] as const,
    adapters: (companyId: string) => ["agents", companyId, "adapters"] as const,
    adapterModels: (companyId: string, adapterType: string) =>
      ["agents", companyId, "adapter-models", adapterType] as const,
    attribution: (agentId: string, companyId?: string) =>
      ["agents", "attribution", agentId, companyId ?? ""] as const,
  },
  issues: {
    list: (companyId: string) => ["issues", companyId] as const,
    search: (companyId: string, q: string, projectId?: string, departmentId?: string) =>
      [
        "issues",
        companyId,
        "search",
        q,
        projectId ?? "__all-projects__",
        departmentId ?? "__all-depts__",
      ] as const,
    listAssignedToMe: (companyId: string) => ["issues", companyId, "assigned-to-me"] as const,
    listTouchedByMe: (companyId: string) => ["issues", companyId, "touched-by-me"] as const,
    listUnreadTouchedByMe: (companyId: string) => ["issues", companyId, "unread-touched-by-me"] as const,
    labels: (companyId: string) => ["issues", companyId, "labels"] as const,
    listByProject: (companyId: string, projectId: string) =>
      ["issues", companyId, "project", projectId] as const,
    detail: (id: string) => ["issues", "detail", id] as const,
    comments: (issueId: string) => ["issues", "comments", issueId] as const,
    attachments: (issueId: string) => ["issues", "attachments", issueId] as const,
    activity: (issueId: string) => ["issues", "activity", issueId] as const,
    runs: (issueId: string) => ["issues", "runs", issueId] as const,
    approvals: (issueId: string) => ["issues", "approvals", issueId] as const,
    qualityReview: (issueId: string) => ["issues", "quality-review", issueId] as const,
    liveRuns: (issueId: string) => ["issues", "live-runs", issueId] as const,
    activeRun: (issueId: string) => ["issues", "active-run", issueId] as const,
  },
  projects: {
    list: (companyId: string) => ["projects", companyId] as const,
    detail: (id: string) => ["projects", "detail", id] as const,
  },
  departments: {
    list: (companyId: string) => ["departments", companyId] as const,
    memberships: (companyId: string, departmentId: string) =>
      ["departments", companyId, "memberships", departmentId] as const,
  },
  goals: {
    list: (companyId: string) => ["goals", companyId] as const,
    detail: (id: string) => ["goals", "detail", id] as const,
  },
  approvals: {
    list: (companyId: string, status?: string) =>
      ["approvals", companyId, status] as const,
    detail: (approvalId: string) => ["approvals", "detail", approvalId] as const,
    comments: (approvalId: string) => ["approvals", "comments", approvalId] as const,
    issues: (approvalId: string) => ["approvals", "issues", approvalId] as const,
  },
  access: {
    joinRequests: (companyId: string, status: string = "pending_approval") =>
      ["access", "join-requests", companyId, status] as const,
    invite: (token: string) => ["access", "invite", token] as const,
  },
  auth: {
    session: ["auth", "session"] as const,
  },
  instance: {
    schedulerHeartbeats: ["instance", "scheduler-heartbeats"] as const,
    status: ["instance", "status"] as const,
  },
  health: ["health"] as const,
  releases: {
    check: ["releases", "check"] as const,
  },
  secrets: {
    list: (companyId: string) => ["secrets", companyId] as const,
    providers: (companyId: string) => ["secret-providers", companyId] as const,
  },
  dashboard: (companyId: string) => ["dashboard", companyId] as const,
  workload: (companyId: string) => ["workload", companyId] as const,
  standup: (companyId: string) => ["standup", companyId] as const,
  sidebarBadges: (companyId: string) => ["sidebar-badges", companyId] as const,
  activity: (companyId: string) => ["activity", companyId] as const,
  costs: (
    companyId: string,
    from?: string,
    to?: string,
    bucket?: "day" | "week",
  ) => ["costs", companyId, from, to, bucket] as const,
  heartbeats: (companyId: string, agentId?: string) =>
    ["heartbeats", companyId, agentId] as const,
  runDetail: (runId: string) => ["heartbeat-run", runId] as const,
  liveRuns: (companyId: string) => ["live-runs", companyId] as const,
  runIssues: (runId: string) => ["run-issues", runId] as const,
  org: (companyId: string) => ["org", companyId] as const,
  workerDownloads: ["worker-downloads"] as const,
  workers: {
    overview: (companyId: string) => ["drones", "overview", companyId] as const,
    pairingRequests: (companyId: string) => ["workers", "pairing-requests", companyId] as const,
  },
};
