export const API_PREFIX = "/api";

export const API = {
  health: `${API_PREFIX}/health`,
  companies: `${API_PREFIX}/companies`,
  agents: `${API_PREFIX}/agents`,
  projects: `${API_PREFIX}/projects`,
  issues: `${API_PREFIX}/issues`,
  goals: `${API_PREFIX}/goals`,
  approvals: `${API_PREFIX}/approvals`,
  secrets: `${API_PREFIX}/secrets`,
  costs: `${API_PREFIX}/costs`,
  activity: `${API_PREFIX}/activity`,
  dashboard: `${API_PREFIX}/dashboard`,
  /** Path for company-scoped workload: GET /api/companies/:companyId/workload */
  workload: (companyId: string) =>
    `${API_PREFIX}/companies/${companyId}/workload`,
  /** Path for company-scoped standup report: GET /api/companies/:companyId/standup */
  standup: (companyId: string) =>
    `${API_PREFIX}/companies/${companyId}/standup`,
  /** Path for company-scoped webhook deliveries: GET/POST /api/companies/:companyId/webhook-deliveries */
  webhookDeliveries: (companyId: string) =>
    `${API_PREFIX}/companies/${companyId}/webhook-deliveries`,
  webhookDeliveriesRetry: (companyId: string) =>
    `${API_PREFIX}/companies/${companyId}/webhook-deliveries/retry`,
  /** Company-scoped connect (CLI): POST /api/companies/:companyId/connect */
  connect: (companyId: string) =>
    `${API_PREFIX}/companies/${companyId}/connect`,
  /** Agent work-items: GET /api/agents/:agentId/work-items */
  workItems: (agentId: string) =>
    `${API_PREFIX}/agents/${agentId}/work-items`,
  sidebarBadges: `${API_PREFIX}/sidebar-badges`,
  invites: `${API_PREFIX}/invites`,
  joinRequests: `${API_PREFIX}/join-requests`,
  members: `${API_PREFIX}/members`,
  admin: `${API_PREFIX}/admin`,
} as const;
