import { useEffect } from "react";
import { Link } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import { standupApi } from "../api/standup";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { Identity } from "../components/Identity";
import { StatusIcon } from "../components/StatusIcon";
import { timeAgo } from "../lib/timeAgo";
import { ClipboardList } from "lucide-react";
import type { StandupIssueSummary, StandupAgentSection } from "@hive/shared";

function IssueLink({ issue }: { issue: StandupIssueSummary }) {
  const to = `/issues/${issue.identifier ?? issue.id}`;
  return (
    <Link
      to={to}
      className="flex items-center gap-2 py-1.5 text-sm hover:bg-accent/50 rounded px-2 -mx-2 no-underline text-inherit cursor-pointer"
    >
      <StatusIcon status={issue.status} className="shrink-0" />
      <span className="truncate min-w-0 flex-1">{issue.title}</span>
    </Link>
  );
}

function IssueList({
  issues,
  emptyMessage,
}: {
  issues: StandupIssueSummary[];
  emptyMessage: string;
}) {
  if (issues.length === 0) {
    return <p className="text-sm text-muted-foreground py-1">{emptyMessage}</p>;
  }
  return (
    <ul className="list-none space-y-0">
      {issues.map((issue) => (
        <li key={issue.id}>
          <IssueLink issue={issue} />
        </li>
      ))}
    </ul>
  );
}

function AgentSection({ section }: { section: StandupAgentSection }) {
  const hasWork =
    section.completed.length > 0 ||
    section.inProgress.length > 0 ||
    section.assigned.length > 0 ||
    section.review.length > 0 ||
    section.blocked.length > 0;

  if (!hasWork) return null;

  return (
    <div className="border border-border rounded-md p-4 space-y-4">
      <h4 className="text-sm font-semibold flex items-center gap-2">
        <Identity name={section.name} size="sm" />
      </h4>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <div>
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">
            Completed
          </p>
          <IssueList issues={section.completed} emptyMessage="None" />
        </div>
        <div>
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">
            In progress
          </p>
          <IssueList issues={section.inProgress} emptyMessage="None" />
        </div>
        <div>
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">
            Assigned
          </p>
          <IssueList issues={section.assigned} emptyMessage="None" />
        </div>
        <div>
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">
            Review
          </p>
          <IssueList issues={section.review} emptyMessage="None" />
        </div>
        <div>
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">
            Blocked
          </p>
          <IssueList issues={section.blocked} emptyMessage="None" />
        </div>
      </div>
    </div>
  );
}

export function Standup() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();

  useEffect(() => {
    setBreadcrumbs([{ label: "Standup" }]);
  }, [setBreadcrumbs]);

  const { data, isLoading, error } = useQuery({
    queryKey: queryKeys.standup(selectedCompanyId!),
    queryFn: () => standupApi.get(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  if (!selectedCompanyId) {
    return (
      <EmptyState
        icon={ClipboardList}
        message="Select a company to view the standup report."
      />
    );
  }

  if (isLoading) {
    return <PageSkeleton variant="list" />;
  }

  const agentSectionsWithWork = data?.agents.filter((a) => {
    return (
      a.completed.length > 0 ||
      a.inProgress.length > 0 ||
      a.assigned.length > 0 ||
      a.review.length > 0 ||
      a.blocked.length > 0
    );
  }) ?? [];
  const totalBlockers = data?.blockers.length ?? 0;
  const totalOverdue = data?.overdue.length ?? 0;

  return (
    <div className="space-y-6">
      {error && (
        <p className="text-sm text-destructive">{error.message}</p>
      )}

      {data && (
        <>
          <p className="text-sm text-muted-foreground">
            {data.agents.length} agent{data.agents.length !== 1 ? "s" : ""}
            {totalBlockers > 0 && ` · ${totalBlockers} blocker${totalBlockers !== 1 ? "s" : ""}`}
            {totalOverdue > 0 && ` · ${totalOverdue} stale (in progress &gt; 1h)`}
          </p>

          {agentSectionsWithWork.length > 0 && (
            <section>
              <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">
                Per agent
              </h3>
              <div className="space-y-4">
                {agentSectionsWithWork.map((section) => (
                  <AgentSection key={section.agentId} section={section} />
                ))}
              </div>
            </section>
          )}

          {(data.teamAccomplishments.length > 0 ||
            data.blockers.length > 0 ||
            data.overdue.length > 0) && (
            <div className="grid gap-4 md:grid-cols-3">
              {data.teamAccomplishments.length > 0 && (
                <div className="border border-border rounded-md p-4">
                  <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">
                    Team accomplishments (last 24h)
                  </h3>
                  <ul className="list-none space-y-0">
                    {data.teamAccomplishments.map((issue) => (
                      <li key={issue.id}>
                        <Link
                          to={`/issues/${issue.identifier ?? issue.id}`}
                          className="flex items-center gap-2 py-1.5 text-sm hover:bg-accent/50 rounded px-2 -mx-2 no-underline text-inherit cursor-pointer"
                        >
                          <StatusIcon status={issue.status} className="shrink-0" />
                          <span className="truncate min-w-0 flex-1">{issue.title}</span>
                          {issue.completedAt && (
                            <span className="text-xs text-muted-foreground shrink-0">
                              {timeAgo(issue.completedAt)}
                            </span>
                          )}
                        </Link>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {data.blockers.length > 0 && (
                <div className="border border-border rounded-md p-4">
                  <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">
                    Blockers
                  </h3>
                  <ul className="list-none space-y-0">
                    {data.blockers.map((issue) => (
                      <li key={issue.id}>
                        <IssueLink issue={issue} />
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {data.overdue.length > 0 && (
                <div className="border border-border rounded-md p-4">
                  <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">
                    Stale (in progress &gt; 1h)
                  </h3>
                  <ul className="list-none space-y-0">
                    {data.overdue.map((issue) => (
                      <li key={issue.id}>
                        <Link
                          to={`/issues/${issue.identifier ?? issue.id}`}
                          className="flex items-center gap-2 py-1.5 text-sm hover:bg-accent/50 rounded px-2 -mx-2 no-underline text-inherit cursor-pointer"
                        >
                          <StatusIcon status={issue.status} className="shrink-0" />
                          <span className="truncate min-w-0 flex-1">{issue.title}</span>
                          {issue.startedAt && (
                            <span className="text-xs text-muted-foreground shrink-0">
                              {timeAgo(issue.startedAt)}
                            </span>
                          )}
                        </Link>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}

          {agentSectionsWithWork.length === 0 &&
            data.teamAccomplishments.length === 0 &&
            data.blockers.length === 0 &&
            data.overdue.length === 0 && (
              <div className="border border-border rounded-md p-6">
                <p className="text-sm text-muted-foreground">
                  No standup data yet. Create tasks and assign them to agents to see per-agent and
                  team summaries here.
                </p>
              </div>
            )}
        </>
      )}
    </div>
  );
}
