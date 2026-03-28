import { useQuery } from "@tanstack/react-query";
import { approvalsApi } from "../api/approvals";
import { accessApi } from "../api/access";
import { sidebarBadgesApi } from "../api/sidebarBadges";
import { dashboardApi } from "../api/dashboard";
import { issuesApi } from "../api/issues";
import { agentsApi } from "../api/agents";
import { heartbeatsApi } from "../api/heartbeats";
import { queryKeys } from "../lib/queryKeys";
import { ISSUE_STATUSES_INBOX } from "@hive/shared";

export function useInboxPageQueries(selectedCompanyId: string | null) {
  const enabled = !!selectedCompanyId;

  const { data: agents, isLoading: isAgentsLoading } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled,
  });

  const {
    data: approvals,
    isLoading: isApprovalsLoading,
    error: approvalsError,
  } = useQuery({
    queryKey: queryKeys.approvals.list(selectedCompanyId!),
    queryFn: () => approvalsApi.list(selectedCompanyId!),
    enabled,
  });

  const { data: joinRequests = [], isLoading: isJoinRequestsLoading } = useQuery({
    queryKey: queryKeys.access.joinRequests(selectedCompanyId!),
    queryFn: () => accessApi.listJoinRequests(selectedCompanyId!, "pending_approval"),
    enabled,
  });

  const { data: sidebarBadges } = useQuery({
    queryKey: queryKeys.sidebarBadges(selectedCompanyId!),
    queryFn: () => sidebarBadgesApi.get(selectedCompanyId!),
    enabled,
    staleTime: 30_000,
  });

  const { data: dashboard, isLoading: isDashboardLoading } = useQuery({
    queryKey: queryKeys.dashboard(selectedCompanyId!),
    queryFn: () => dashboardApi.summary(selectedCompanyId!),
    enabled,
  });

  const { data: issues, isLoading: isIssuesLoading } = useQuery({
    queryKey: queryKeys.issues.list(selectedCompanyId!),
    queryFn: () => issuesApi.list(selectedCompanyId!),
    enabled,
  });

  const { data: touchedIssuesRaw = [], isLoading: isTouchedIssuesLoading } = useQuery({
    queryKey: queryKeys.issues.listTouchedByMe(selectedCompanyId!),
    queryFn: () =>
      issuesApi.list(selectedCompanyId!, {
        touchedByUserId: "me",
        status: ISSUE_STATUSES_INBOX.join(","),
      }),
    enabled,
  });

  const { data: heartbeatRuns, isLoading: isRunsLoading } = useQuery({
    queryKey: queryKeys.heartbeats(selectedCompanyId!),
    queryFn: () => heartbeatsApi.list(selectedCompanyId!),
    enabled,
  });

  return {
    agents,
    isAgentsLoading,
    approvals,
    isApprovalsLoading,
    approvalsError,
    joinRequests,
    isJoinRequestsLoading,
    sidebarBadges,
    dashboard,
    isDashboardLoading,
    issues,
    isIssuesLoading,
    touchedIssuesRaw,
    isTouchedIssuesLoading,
    heartbeatRuns,
    isRunsLoading,
  };
}
