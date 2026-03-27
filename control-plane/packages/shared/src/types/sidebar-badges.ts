export interface SidebarBadges {
  inbox: number;
  approvals: number;
  failedRuns: number;
  joinRequests: number;
  /** True when the current principal may approve or reject join requests (mutations remain server-enforced). */
  canApproveJoinRequests: boolean;
}
