import { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useNavigate } from "@/lib/router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { approvalsApi } from "../api/approvals";
import { accessApi } from "../api/access";
import { issuesApi } from "../api/issues";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { createIssueDetailLocationState } from "../lib/issueDetailBreadcrumb";
import {
  ISSUE_STATUS_TODO,
  ISSUE_STATUS_IN_PROGRESS,
  ISSUE_STATUS_BLOCKED,
} from "@hive/shared";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { ApprovalCard } from "../components/ApprovalCard";
import { IssueRow } from "../components/IssueRow";
import { PriorityIcon } from "../components/PriorityIcon";
import { StatusIcon } from "../components/StatusIcon";
import { timeAgo } from "../lib/timeAgo";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Tabs } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Inbox as InboxIcon,
  AlertTriangle,
  ArrowUpRight,
  XCircle,
  X,
  RotateCcw,
  ShieldCheck,
  UserPlus,
  CircleDot,
  Clock,
} from "lucide-react";
import { Identity } from "../components/Identity";
import { PageTabBar } from "../components/PageTabBar";
import { SectionHeader } from "../components/SectionHeader";
import type { HeartbeatRun, Issue, JoinRequest } from "@hive/shared";
import {
  ACTIONABLE_APPROVAL_STATUSES,
  getLatestFailedRunsByAgent,
  getRecentTouchedIssues,
  type InboxTab,
  readIssueIdFromRun,
  saveLastInboxTab,
} from "../lib/inbox";
import { useDismissedInboxItems } from "../hooks/useInboxBadge";
import { useInboxPageQueries } from "../hooks/useInboxPageQueries";
import { FailedRunCard } from "../components/inbox/FailedRunCard";

type InboxCategoryFilter =
  | "everything"
  | "issues_i_touched"
  | "join_requests"
  | "approvals"
  | "failed_runs"
  | "alerts";
type InboxApprovalFilter = "all" | "actionable" | "resolved";
type SectionKey =
  | "issues_i_touched"
  | "join_requests"
  | "approvals"
  | "failed_runs"
  | "alerts"
  | "stale_work";

export function Inbox() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const [actionError, setActionError] = useState<string | null>(null);
  const [failedApprovalId, setFailedApprovalId] = useState<string | null>(null);
  const [allCategoryFilter, setAllCategoryFilter] = useState<InboxCategoryFilter>("everything");
  const [allApprovalFilter, setAllApprovalFilter] = useState<InboxApprovalFilter>("all");
  const { dismissed, dismiss } = useDismissedInboxItems();

  const pathSegment = location.pathname.split("/").pop() ?? "recent";
  const tab: InboxTab =
    pathSegment === "all" || pathSegment === "unread"
      ? pathSegment
      : pathSegment === "new"
        ? "new"
        : "recent";
  const issueLinkState = useMemo(
    () =>
      createIssueDetailLocationState(
        "Inbox",
        `${location.pathname}${location.search}${location.hash}`,
      ),
    [location.pathname, location.search, location.hash],
  );

  const {
    agents,
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
  } = useInboxPageQueries(selectedCompanyId);
  const canApproveJoinRequests = sidebarBadges?.canApproveJoinRequests ?? false;

  useEffect(() => {
    setBreadcrumbs([{ label: "Inbox" }]);
  }, [setBreadcrumbs]);

  useEffect(() => {
    saveLastInboxTab(tab);
  }, [tab]);

  const touchedIssues = useMemo(() => getRecentTouchedIssues(touchedIssuesRaw), [touchedIssuesRaw]);
  const unreadTouchedIssues = useMemo(
    () => touchedIssues.filter((issue) => issue.isUnreadForMe),
    [touchedIssues],
  );

  const agentById = useMemo(() => {
    const map = new Map<string, string>();
    for (const agent of agents ?? []) map.set(agent.id, agent.name);
    return map;
  }, [agents]);

  const issueById = useMemo(() => {
    const map = new Map<string, Issue>();
    for (const issue of issues ?? []) map.set(issue.id, issue);
    return map;
  }, [issues]);

  const failedRuns = useMemo(
    () => getLatestFailedRunsByAgent(heartbeatRuns ?? []).filter((r) => !dismissed.has(`run:${r.id}`)),
    [heartbeatRuns, dismissed],
  );
  const liveIssueIds = useMemo(() => {
    const ids = new Set<string>();
    for (const run of heartbeatRuns ?? []) {
      if (run.status !== "running" && run.status !== "queued") continue;
      const issueId = readIssueIdFromRun(run);
      if (issueId) ids.add(issueId);
    }
    return ids;
  }, [heartbeatRuns]);

  const allApprovals = useMemo(
    () =>
      [...(approvals ?? [])].sort(
        (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      ),
    [approvals],
  );

  const actionableApprovals = useMemo(
    () => allApprovals.filter((approval) => ACTIONABLE_APPROVAL_STATUSES.has(approval.status)),
    [allApprovals],
  );

  const filteredAllApprovals = useMemo(() => {
    if (allApprovalFilter === "all") return allApprovals;

    return allApprovals.filter((approval) => {
      const isActionable = ACTIONABLE_APPROVAL_STATUSES.has(approval.status);
      return allApprovalFilter === "actionable" ? isActionable : !isActionable;
    });
  }, [allApprovals, allApprovalFilter]);

  const agentName = (id: string | null) => {
    if (!id) return null;
    return agentById.get(id) ?? null;
  };

  const approveMutation = useMutation({
    mutationFn: (arg: { id: string; payload?: unknown }) => approvalsApi.approve(arg.id),
    onSuccess: (_approval, arg) => {
      setActionError(null);
      setFailedApprovalId(null);
      queryClient.invalidateQueries({ queryKey: queryKeys.approvals.list(selectedCompanyId!) });
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(selectedCompanyId!) });
      const payload = arg?.payload as Record<string, unknown> | undefined;
      const agentId = typeof payload?.agentId === "string" ? payload.agentId : null;
      if (agentId) {
        queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agentId) });
      }
      navigate(`/approvals/${arg.id}?resolved=approved`);
    },
    onError: (err, arg) => {
      setActionError(err instanceof Error ? err.message : "Failed to approve");
      setFailedApprovalId(arg?.id ?? null);
    },
  });

  const rejectMutation = useMutation({
    mutationFn: (id: string) => approvalsApi.reject(id),
    onSuccess: () => {
      setActionError(null);
      setFailedApprovalId(null);
      queryClient.invalidateQueries({ queryKey: queryKeys.approvals.list(selectedCompanyId!) });
    },
    onError: (err, id) => {
      setActionError(err instanceof Error ? err.message : "Failed to reject");
      setFailedApprovalId(id);
    },
  });

  const approveJoinMutation = useMutation({
    mutationFn: (joinRequest: JoinRequest) =>
      accessApi.approveJoinRequest(selectedCompanyId!, joinRequest.id),
    onSuccess: () => {
      setActionError(null);
      queryClient.invalidateQueries({ queryKey: queryKeys.access.joinRequests(selectedCompanyId!) });
      queryClient.invalidateQueries({ queryKey: queryKeys.sidebarBadges(selectedCompanyId!) });
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(selectedCompanyId!) });
      queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
    },
    onError: (err) => {
      setActionError(err instanceof Error ? err.message : "Failed to approve join request");
    },
  });

  const rejectJoinMutation = useMutation({
    mutationFn: (joinRequest: JoinRequest) =>
      accessApi.rejectJoinRequest(selectedCompanyId!, joinRequest.id),
    onSuccess: () => {
      setActionError(null);
      queryClient.invalidateQueries({ queryKey: queryKeys.access.joinRequests(selectedCompanyId!) });
      queryClient.invalidateQueries({ queryKey: queryKeys.sidebarBadges(selectedCompanyId!) });
    },
    onError: (err) => {
      setActionError(err instanceof Error ? err.message : "Failed to reject join request");
    },
  });

  const [fadingOutIssues, setFadingOutIssues] = useState<Set<string>>(new Set());

  const invalidateInboxIssueQueries = () => {
    if (!selectedCompanyId) return;
    queryClient.invalidateQueries({ queryKey: queryKeys.issues.listTouchedByMe(selectedCompanyId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.issues.listUnreadTouchedByMe(selectedCompanyId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.sidebarBadges(selectedCompanyId) });
  };

  const markReadMutation = useMutation({
    mutationFn: (id: string) => issuesApi.markRead(id),
    onMutate: (id) => {
      setFadingOutIssues((prev) => new Set(prev).add(id));
    },
    onSuccess: () => {
      invalidateInboxIssueQueries();
    },
    onSettled: (_data, _error, id) => {
      setTimeout(() => {
        setFadingOutIssues((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      }, 300);
    },
  });

  const markAllReadMutation = useMutation({
    mutationFn: async (issueIds: string[]) => {
      await Promise.all(issueIds.map((issueId) => issuesApi.markRead(issueId)));
    },
    onMutate: (issueIds) => {
      setFadingOutIssues((prev) => {
        const next = new Set(prev);
        for (const issueId of issueIds) next.add(issueId);
        return next;
      });
    },
    onSuccess: () => {
      invalidateInboxIssueQueries();
    },
    onSettled: (_data, _error, issueIds) => {
      setTimeout(() => {
        setFadingOutIssues((prev) => {
          const next = new Set(prev);
          for (const issueId of issueIds) next.delete(issueId);
          return next;
        });
      }, 300);
    },
  });

  if (!selectedCompanyId) {
    return <EmptyState icon={InboxIcon} message="Select a company to view inbox." />;
  }

  const hasRunFailures = failedRuns.length > 0;
  const showAggregateAgentError = !!dashboard && dashboard.agents.error > 0 && !hasRunFailures && !dismissed.has("alert:agent-errors");
  const showBudgetAlert =
    !!dashboard &&
    dashboard.costs.monthBudgetCents > 0 &&
    dashboard.costs.monthUtilizationPercent >= 80 &&
    !dismissed.has("alert:budget");
  const hasAlerts = showAggregateAgentError || showBudgetAlert;
  const hasJoinRequests = joinRequests.length > 0;
  const hasTouchedIssues = touchedIssues.length > 0;

  const showJoinRequestsCategory =
    allCategoryFilter === "everything" || allCategoryFilter === "join_requests";
  const showTouchedCategory =
    allCategoryFilter === "everything" || allCategoryFilter === "issues_i_touched";
  const showApprovalsCategory = allCategoryFilter === "everything" || allCategoryFilter === "approvals";
  const showFailedRunsCategory =
    allCategoryFilter === "everything" || allCategoryFilter === "failed_runs";
  const showAlertsCategory = allCategoryFilter === "everything" || allCategoryFilter === "alerts";

  const approvalsToRender = tab === "all" ? filteredAllApprovals : actionableApprovals;
  const showTouchedSection =
    tab === "all"
      ? showTouchedCategory && hasTouchedIssues
      : tab === "unread"
        ? unreadTouchedIssues.length > 0
        : hasTouchedIssues;
  const showJoinRequestsSection =
    tab === "all" ? showJoinRequestsCategory && hasJoinRequests : tab === "unread" && hasJoinRequests;
  const showApprovalsSection = tab === "all"
    ? showApprovalsCategory && filteredAllApprovals.length > 0
    : actionableApprovals.length > 0;
  const showFailedRunsSection =
    tab === "all" ? showFailedRunsCategory && hasRunFailures : tab === "unread" && hasRunFailures;
  const showAlertsSection = tab === "all" ? showAlertsCategory && hasAlerts : tab === "unread" && hasAlerts;

  const staleIssues = useMemo(() => {
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    return (issues ?? []).filter(
      (issue) =>
        !dismissed.has(`stale:${issue.id}`) &&
        [ISSUE_STATUS_TODO, ISSUE_STATUS_IN_PROGRESS, ISSUE_STATUS_BLOCKED].includes(issue.status) &&
        new Date(issue.updatedAt).getTime() < cutoff,
    );
  }, [issues, dismissed]);
  const showStaleSection = tab === "all" ? staleIssues.length > 0 : tab === "unread" && staleIssues.length > 0;

  const visibleSections = (
    showApprovalsSection && tab === "new" && actionableApprovals.length > 0
      ? [
          "approvals",
          showFailedRunsSection ? "failed_runs" : null,
          showAlertsSection ? "alerts" : null,
          showStaleSection ? "stale_work" : null,
          showJoinRequestsSection ? "join_requests" : null,
          showTouchedSection ? "issues_i_touched" : null,
        ]
      : [
          showFailedRunsSection ? "failed_runs" : null,
          showAlertsSection ? "alerts" : null,
          showStaleSection ? "stale_work" : null,
          showApprovalsSection ? "approvals" : null,
          showJoinRequestsSection ? "join_requests" : null,
          showTouchedSection ? "issues_i_touched" : null,
        ]
  ).filter((key): key is SectionKey => key !== null);

  const allLoaded =
    !isJoinRequestsLoading &&
    !isApprovalsLoading &&
    !isDashboardLoading &&
    !isIssuesLoading &&
    !isTouchedIssuesLoading &&
    !isRunsLoading;

  const showSeparatorBefore = (key: SectionKey) => visibleSections.indexOf(key) > 0;
  const unreadIssueIds = unreadTouchedIssues
    .filter((issue) => !fadingOutIssues.has(issue.id))
    .map((issue) => issue.id);
  const canMarkAllRead = unreadIssueIds.length > 0;

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap items-center gap-2">
          <Tabs value={tab} onValueChange={(value) => navigate(`/inbox/${value}`)}>
            <PageTabBar
              items={[
                {
                  value: "recent",
                  label: "Recent",
                },
                { value: "unread", label: "Unread" },
                { value: "all", label: "All" },
              ]}
            />
          </Tabs>

          {canMarkAllRead && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8 shrink-0"
              onClick={() => markAllReadMutation.mutate(unreadIssueIds)}
              disabled={markAllReadMutation.isPending}
            >
              {markAllReadMutation.isPending ? "Marking…" : "Mark all as read"}
            </Button>
          )}
        </div>

        {tab === "all" && (
          <div className="flex flex-wrap items-center gap-2 sm:justify-end">
            <Select
              value={allCategoryFilter}
              onValueChange={(value) => setAllCategoryFilter(value as InboxCategoryFilter)}
            >
              <SelectTrigger className="h-8 w-[170px] text-xs">
                <SelectValue placeholder="Category" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="everything">All categories</SelectItem>
                <SelectItem value="issues_i_touched">My recent issues</SelectItem>
                <SelectItem value="join_requests">Join requests</SelectItem>
                <SelectItem value="approvals">Approvals</SelectItem>
                <SelectItem value="failed_runs">Failed runs</SelectItem>
                <SelectItem value="alerts">Alerts</SelectItem>
              </SelectContent>
            </Select>

            {showApprovalsCategory && (
              <Select
                value={allApprovalFilter}
                onValueChange={(value) => setAllApprovalFilter(value as InboxApprovalFilter)}
              >
                <SelectTrigger className="h-8 w-[170px] text-xs">
                  <SelectValue placeholder="Approval status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All approval statuses</SelectItem>
                  <SelectItem value="actionable">Needs action</SelectItem>
                  <SelectItem value="resolved">Resolved</SelectItem>
                </SelectContent>
              </Select>
            )}
          </div>
        )}
      </div>

      {approvalsError && <p className="text-sm text-destructive">{approvalsError.message}</p>}
      {actionError && !failedApprovalId && <p className="text-sm text-destructive">{actionError}</p>}

      {!allLoaded && visibleSections.length === 0 && (
        <PageSkeleton variant="inbox" />
      )}

      {allLoaded && visibleSections.length === 0 && (
        <EmptyState
          icon={InboxIcon}
          message={
            tab === "unread"
              ? "No new inbox items."
              : tab === "recent"
                ? "No recent inbox items."
                : "No inbox items match these filters."
          }
        />
      )}

      {showApprovalsSection && (
        <>
          {showSeparatorBefore("approvals") && <Separator />}
          <div>
            <SectionHeader
              icon={<ShieldCheck className="h-4 w-4 shrink-0 text-muted-foreground" />}
              title={tab === "new" ? "Approvals Needing Action" : "Approvals"}
              count={approvalsToRender.length}
              trailing={
                <Link
                  to="/approvals"
                  className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                >
                  View all
                </Link>
              }
            />
            <div className="grid gap-3 rounded-b-md border border-border border-t-0 p-3">
              {approvalsToRender.map((approval) => (
                <ApprovalCard
                  key={approval.id}
                  approval={approval}
                  requesterAgent={
                    approval.requestedByAgentId
                      ? (agents ?? []).find((a) => a.id === approval.requestedByAgentId) ?? null
                      : null
                  }
                  onApprove={() => approveMutation.mutate({ id: approval.id, payload: approval.payload })}
                  onReject={() => rejectMutation.mutate(approval.id)}
                  detailLink={`/approvals/${approval.id}`}
                  isPending={approveMutation.isPending || rejectMutation.isPending}
                  variant="compact"
                  errorMessage={failedApprovalId === approval.id ? actionError : undefined}
                />
              ))}
            </div>
          </div>
        </>
      )}

      {showJoinRequestsSection && (
        <>
          {showSeparatorBefore("join_requests") && <Separator />}
          <div>
            <SectionHeader
              icon={<UserPlus className="h-4 w-4 shrink-0 text-muted-foreground" />}
              title="Join Requests"
              count={joinRequests.length}
            />
            <div className="grid gap-3 rounded-b-md border border-border border-t-0 p-3">
              {joinRequests.map((joinRequest) => (
                <div key={joinRequest.id} className="rounded-xl border border-border bg-card p-4">
                  <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                    <div className="space-y-1">
                      <p className="text-sm font-medium">
                        {joinRequest.requestType === "human"
                          ? "Human join request"
                          : `Agent join request${joinRequest.agentName ? `: ${joinRequest.agentName}` : ""}`}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        requested {timeAgo(joinRequest.createdAt)} from IP {joinRequest.requestIp}
                      </p>
                      {joinRequest.requestEmailSnapshot && (
                        <p className="text-xs text-muted-foreground">
                          email: {joinRequest.requestEmailSnapshot}
                        </p>
                      )}
                      {joinRequest.adapterType && (
                        <p className="text-xs text-muted-foreground">adapter: {joinRequest.adapterType}</p>
                      )}
                    </div>
                    <div className="flex flex-col items-end gap-1 sm:flex-row sm:items-center sm:gap-2">
                      {canApproveJoinRequests ? (
                        <>
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={approveJoinMutation.isPending || rejectJoinMutation.isPending}
                            onClick={() => rejectJoinMutation.mutate(joinRequest)}
                          >
                            Reject
                          </Button>
                          <Button
                            size="sm"
                            disabled={approveJoinMutation.isPending || rejectJoinMutation.isPending}
                            onClick={() => approveJoinMutation.mutate(joinRequest)}
                          >
                            Approve
                          </Button>
                        </>
                      ) : (
                        <p className="max-w-[220px] text-right text-xs text-muted-foreground">
                          Only members with join approval permission can approve or reject.
                        </p>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </>
      )}

      {showFailedRunsSection && (
        <>
          {showSeparatorBefore("failed_runs") && <Separator />}
          <div>
            <SectionHeader
              icon={<XCircle className="h-4 w-4 shrink-0 text-muted-foreground" />}
              title="Failed Runs"
              count={failedRuns.length}
            />
            <div className="grid gap-3 rounded-b-md border border-border border-t-0 p-3">
              {failedRuns.map((run) => (
                <FailedRunCard
                  key={run.id}
                  run={run}
                  issueById={issueById}
                  agentName={agentName(run.agentId)}
                  issueLinkState={issueLinkState}
                  onDismiss={() => dismiss(`run:${run.id}`)}
                />
              ))}
            </div>
          </div>
        </>
      )}

      {showAlertsSection && (
        <>
          {showSeparatorBefore("alerts") && <Separator />}
          <div>
            <SectionHeader
              icon={<AlertTriangle className="h-4 w-4 shrink-0 text-muted-foreground" />}
              title="Alerts"
              count={(showAggregateAgentError ? 1 : 0) + (showBudgetAlert ? 1 : 0)}
            />
            <div className="divide-y divide-border border border-border rounded-b-md border-t-0">
              {showAggregateAgentError && (
                <div className="group/alert relative flex items-center gap-3 px-4 py-3 transition-colors hover:bg-accent/50">
                  <Link
                    to="/agents"
                    className="flex flex-1 cursor-pointer items-center gap-3 no-underline text-inherit"
                  >
                    <AlertTriangle className="h-4 w-4 shrink-0 text-red-600 dark:text-red-400" />
                    <span className="text-sm">
                      <span className="font-medium">{dashboard!.agents.error}</span>{" "}
                      {dashboard!.agents.error === 1 ? "agent has" : "agents have"} errors
                    </span>
                  </Link>
                  <button
                    type="button"
                    onClick={() => dismiss("alert:agent-errors")}
                    className="rounded-md p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground group-hover/alert:opacity-100"
                    aria-label="Dismiss"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              )}
              {showBudgetAlert && (
                <div className="group/alert relative flex items-center gap-3 px-4 py-3 transition-colors hover:bg-accent/50">
                  <Link
                    to="/costs"
                    className="flex flex-1 cursor-pointer items-center gap-3 no-underline text-inherit"
                  >
                    <AlertTriangle className="h-4 w-4 shrink-0 text-yellow-400" />
                    <span className="text-sm">
                      Budget at{" "}
                      <span className="font-medium">{dashboard!.costs.monthUtilizationPercent}%</span>{" "}
                      utilization this month
                    </span>
                  </Link>
                  <button
                    type="button"
                    onClick={() => dismiss("alert:budget")}
                    className="rounded-md p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground group-hover/alert:opacity-100"
                    aria-label="Dismiss"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              )}
            </div>
          </div>
        </>
      )}

      {showStaleSection && (
        <>
          {showSeparatorBefore("stale_work") && <Separator />}
          <div>
            <SectionHeader
              icon={<Clock className="h-4 w-4 shrink-0 text-muted-foreground" />}
              title="Stale Work"
              count={staleIssues.length}
            />
            <div className="divide-y divide-border border border-border rounded-b-md border-t-0">
              {staleIssues.map((issue) => (
                <div
                  key={issue.id}
                  className="group/stale relative flex items-start gap-2 overflow-hidden px-3 py-3 transition-colors hover:bg-accent/50 sm:items-center sm:gap-3 sm:px-4"
                >
                  {/* Status icon - left column on mobile; Clock icon on desktop */}
                  <span className="shrink-0 sm:hidden">
                    <StatusIcon status={issue.status} />
                  </span>
                  <Clock className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground hidden sm:block sm:mt-0" />

                  <Link
                    to={`/issues/${issue.identifier ?? issue.id}`}
                    className="flex min-w-0 flex-1 cursor-pointer flex-col gap-1 no-underline text-inherit sm:flex-row sm:items-center sm:gap-3"
                  >
                    <span className="line-clamp-2 text-sm sm:order-2 sm:flex-1 sm:min-w-0 sm:line-clamp-none sm:truncate">
                      {issue.title}
                    </span>
                    <span className="flex items-center gap-2 sm:order-1 sm:shrink-0">
                      <span className="hidden sm:inline-flex"><PriorityIcon priority={issue.priority} /></span>
                      <span className="hidden sm:inline-flex"><StatusIcon status={issue.status} /></span>
                      <span className="shrink-0 text-xs font-mono text-muted-foreground">
                        {issue.identifier ?? issue.id.slice(0, 8)}
                      </span>
                      {issue.assigneeAgentId &&
                        (() => {
                          const name = agentName(issue.assigneeAgentId);
                          return name ? (
                            <span className="hidden sm:inline-flex"><Identity name={name} size="sm" /></span>
                          ) : null;
                        })()}
                      <span className="text-xs text-muted-foreground sm:hidden">&middot;</span>
                      <span className="shrink-0 text-xs text-muted-foreground sm:order-last">
                        updated {timeAgo(issue.updatedAt)}
                      </span>
                    </span>
                  </Link>
                  <button
                    type="button"
                    onClick={() => dismiss(`stale:${issue.id}`)}
                    className="mt-0.5 rounded-md p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground group-hover/stale:opacity-100 sm:mt-0"
                    aria-label="Dismiss"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
            </div>
          </div>
        </>
      )}

      {showTouchedSection && (
        <>
          {showSeparatorBefore("issues_i_touched") && <Separator />}
          <div>
              {(tab === "unread" ? unreadTouchedIssues : touchedIssues).map((issue) => {
                const isUnread = issue.isUnreadForMe && !fadingOutIssues.has(issue.id);
                const isFading = fadingOutIssues.has(issue.id);
                return (
                  <IssueRow
                    key={issue.id}
                    issue={issue}
                    issueLinkState={issueLinkState}
                    desktopMetaLeading={(
                      <>
                        <span className="hidden sm:inline-flex">
                          <PriorityIcon priority={issue.priority} />
                        </span>
                        <span className="hidden shrink-0 sm:inline-flex">
                          <StatusIcon status={issue.status} />
                        </span>
                        <span className="shrink-0 font-mono text-xs text-muted-foreground">
                          {issue.identifier ?? issue.id.slice(0, 8)}
                        </span>
                        {liveIssueIds.has(issue.id) && (
                          <span className="inline-flex items-center gap-1 rounded-full bg-accent/10 px-1.5 py-0.5 sm:gap-1.5 sm:px-2">
                            <span className="relative flex h-2 w-2">
                              <span className="absolute inline-flex h-full w-full animate-pulse rounded-full bg-accent opacity-75" />
                              <span className="relative inline-flex h-2 w-2 rounded-full bg-accent" />
                            </span>
                            <span className="hidden text-[11px] font-medium text-accent sm:inline">
                              Live
                            </span>
                          </span>
                        )}
                      </>
                    )}
                    mobileMeta={
                      issue.lastExternalCommentAt
                        ? `commented ${timeAgo(issue.lastExternalCommentAt)}`
                        : `updated ${timeAgo(issue.updatedAt)}`
                    }
                    unreadState={isUnread ? "visible" : isFading ? "fading" : "hidden"}
                    onMarkRead={() => markReadMutation.mutate(issue.id)}
                    trailingMeta={
                      issue.lastExternalCommentAt
                        ? `commented ${timeAgo(issue.lastExternalCommentAt)}`
                        : `updated ${timeAgo(issue.updatedAt)}`
                    }
                  />
                );
              })}
            </div>
        </>
      )}
    </div>
  );
}
