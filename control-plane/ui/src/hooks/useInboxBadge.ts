import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { accessApi } from "../api/access";
import { ApiError } from "../api/client";
import { approvalsApi } from "../api/approvals";
import { dashboardApi } from "../api/dashboard";
import { heartbeatsApi } from "../api/heartbeats";
import { issuesApi } from "../api/issues";
import { queryKeys } from "../lib/queryKeys";
import {
  computeInboxBadgeData,
  getRecentTouchedIssues,
  loadDismissedInboxItems,
  saveDismissedInboxItems,
  getUnreadTouchedIssues,
} from "../lib/inbox";
import { ISSUE_STATUSES_INBOX } from "@hive/shared";

export function useDismissedInboxItems() {
  const [dismissed, setDismissed] = useState<Set<string>>(loadDismissedInboxItems);

  useEffect(() => {
    const handleStorage = (event: StorageEvent) => {
      if (event.key !== "hive:inbox:dismissed") return;
      setDismissed(loadDismissedInboxItems());
    };
    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, []);

  const dismiss = (id: string) => {
    setDismissed((prev) => {
      const next = new Set(prev);
      next.add(id);
      saveDismissedInboxItems(next);
      return next;
    });
  };

  return { dismissed, dismiss };
}

export function useInboxBadge(companyId: string | null | undefined) {
  const { dismissed } = useDismissedInboxItems();

  const { data: approvals = [] } = useQuery({
    queryKey: queryKeys.approvals.list(companyId!),
    queryFn: () => approvalsApi.list(companyId!),
    enabled: !!companyId,
  });

  const { data: joinRequests = [] } = useQuery({
    queryKey: queryKeys.access.joinRequests(companyId!),
    queryFn: async () => {
      try {
        return await accessApi.listJoinRequests(companyId!, "pending_approval");
      } catch (err) {
        if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
          return [];
        }
        throw err;
      }
    },
    enabled: !!companyId,
    retry: false,
  });

  const { data: dashboard } = useQuery({
    queryKey: queryKeys.dashboard(companyId!),
    queryFn: () => dashboardApi.summary(companyId!),
    enabled: !!companyId,
  });

  const { data: touchedIssues = [] } = useQuery({
    queryKey: queryKeys.issues.listTouchedByMe(companyId!),
    queryFn: () =>
      issuesApi.list(companyId!, {
        touchedByUserId: "me",
        status: ISSUE_STATUSES_INBOX.join(","),
      }),
    enabled: !!companyId,
  });

  const unreadIssues = useMemo(
    () => getUnreadTouchedIssues(getRecentTouchedIssues(touchedIssues)),
    [touchedIssues],
  );

  const { data: heartbeatRuns = [] } = useQuery({
    queryKey: queryKeys.heartbeats(companyId!),
    queryFn: () => heartbeatsApi.list(companyId!),
    enabled: !!companyId,
  });

  return useMemo(
    () =>
      computeInboxBadgeData({
        approvals,
        joinRequests,
        dashboard,
        heartbeatRuns,
        unreadIssues,
        dismissed,
      }),
    [approvals, joinRequests, dashboard, heartbeatRuns, unreadIssues, dismissed],
  );
}
