import { Link, Navigate } from "@/lib/router";
import { useDialog } from "../context/DialogContext";
import { PageTabBar } from "../components/PageTabBar";
import { roleLabels } from "../components/agent-config-primitives";
import { StatusBadge } from "../components/StatusBadge";
import { PageSkeleton } from "../components/PageSkeleton";
import { cn } from "../lib/utils";
import { Button } from "@/components/ui/button";
import { Tabs } from "@/components/ui/tabs";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  MoreHorizontal,
  Play,
  Pause,
  Plus,
  Settings,
  Timer,
  Trash2,
  Copy,
  RotateCcw,
} from "lucide-react";
import { AgentIcon, AgentIconPicker } from "../components/AgentIconPicker";
import {
  AgentOverview,
  AgentConfigurePage,
  RunsTab,
  AttributionTab,
} from "../components/agent-detail/agent-detail-internals.js";
import { useAgentDetailPage } from "../hooks/useAgentDetailPage.js";

export function AgentDetail() {
  const { openNewIssue } = useDialog();
  const {
    urlRunId,
    urlTab,
    setActionError,
    agent,
    isLoading,
    error,
    activeView,
    actionError,
    moreOpen,
    setMoreOpen,
    configDirty,
    setConfigDirty,
    configSaving,
    setConfigSaving,
    saveConfigActionRef,
    cancelConfigActionRef,
    setSaveConfigAction,
    setCancelConfigAction,
    isMobile,
    canonicalAgentRef,
    resolvedCompanyId,
    runtimeState,
    heartbeats,
    assignedIssues,
    reportsToAgent,
    directReports,
    mobileLiveRun,
    agentAction,
    updateIcon,
    resetTaskSession,
    updatePermissions,
    navigate,
  } = useAgentDetailPage();

  if (isLoading) return <PageSkeleton variant="detail" />;
  if (error) return <p className="text-sm text-destructive">{error.message}</p>;
  if (!agent) return null;
  if (!urlRunId && !urlTab) {
    return <Navigate to={`/agents/${canonicalAgentRef}/overview`} replace />;
  }

  const isPendingApproval = agent.status === "pending_approval";
  const showConfigActionBar = activeView === "configure" && (configDirty || configSaving);

  return (
    <div className={cn("space-y-6", isMobile && showConfigActionBar && "pb-24")}>
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-3 min-w-0">
          <AgentIconPicker value={agent.icon} onChange={(icon) => updateIcon.mutate(icon)}>
            <button className="shrink-0 flex items-center justify-center h-12 w-12 rounded-lg bg-accent hover:bg-accent/80 transition-colors cursor-pointer">
              <AgentIcon icon={agent.icon} className="h-6 w-6" />
            </button>
          </AgentIconPicker>
          <div className="min-w-0">
            <h2 className="text-2xl font-bold truncate">{agent.name}</h2>
            <p className="text-sm text-muted-foreground truncate">
              {roleLabels[agent.role] ?? agent.role}
              {agent.title ? ` - ${agent.title}` : ""}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-1 sm:gap-2 shrink-0">
          <Button variant="outline" size="sm" onClick={() => openNewIssue({ assigneeAgentId: agent.id })}>
            <Plus className="h-3.5 w-3.5 sm:mr-1" />
            <span className="hidden sm:inline">Assign Task</span>
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => agentAction.mutate("invoke")}
            disabled={agentAction.isPending || isPendingApproval}
          >
            <Play className="h-3.5 w-3.5 sm:mr-1" />
            <span className="hidden sm:inline">Run Heartbeat</span>
          </Button>
          {agent.status === "paused" ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => agentAction.mutate("resume")}
              disabled={agentAction.isPending || isPendingApproval}
            >
              <Play className="h-3.5 w-3.5 sm:mr-1" />
              <span className="hidden sm:inline">Resume</span>
            </Button>
          ) : (
            <Button
              variant="outline"
              size="sm"
              onClick={() => agentAction.mutate("pause")}
              disabled={agentAction.isPending || isPendingApproval}
            >
              <Pause className="h-3.5 w-3.5 sm:mr-1" />
              <span className="hidden sm:inline">Pause</span>
            </Button>
          )}
          <span className="hidden sm:inline">
            <StatusBadge status={agent.status} />
          </span>
          {mobileLiveRun && (
            <Link
              to={`/agents/${canonicalAgentRef}/runs/${mobileLiveRun.id}`}
              className="sm:hidden flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-accent/10 hover:bg-accent/20 transition-colors no-underline"
            >
              <span className="relative flex h-2 w-2">
                <span className="animate-pulse absolute inline-flex h-full w-full rounded-full bg-accent opacity-75" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-accent" />
              </span>
              <span className="text-[11px] font-medium text-accent">Live</span>
            </Link>
          )}

          <Popover open={moreOpen} onOpenChange={setMoreOpen}>
            <PopoverTrigger asChild>
              <Button variant="ghost" size="icon-xs">
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-44 p-1" align="end">
              <button
                className="flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50"
                onClick={() => {
                  navigate(`/agents/${canonicalAgentRef}/configure`);
                  setMoreOpen(false);
                }}
              >
                <Settings className="h-3 w-3" />
                Configure Agent
              </button>
              <button
                className="flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50"
                onClick={() => {
                  navigate(`/agents/${canonicalAgentRef}/attribution`);
                  setMoreOpen(false);
                }}
              >
                <Timer className="h-3 w-3" />
                Attribution report
              </button>
              <button
                className="flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50"
                onClick={() => {
                  navigator.clipboard.writeText(agent.id);
                  setMoreOpen(false);
                }}
              >
                <Copy className="h-3 w-3" />
                Copy Agent ID
              </button>
              <button
                className="flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50"
                onClick={() => {
                  resetTaskSession.mutate(null);
                  setMoreOpen(false);
                }}
              >
                <RotateCcw className="h-3 w-3" />
                Reset Sessions
              </button>
              <button
                className="flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50 text-destructive cursor-pointer"
                onClick={() => {
                  agentAction.mutate("terminate");
                  setMoreOpen(false);
                }}
              >
                <Trash2 className="h-3 w-3" />
                Terminate
              </button>
            </PopoverContent>
          </Popover>
        </div>
      </div>

      {!urlRunId && (
        <Tabs
          value={activeView}
          onValueChange={(value) => navigate(`/agents/${canonicalAgentRef}/${value}`)}
        >
          <PageTabBar
            items={[
              { value: "overview", label: "Overview" },
              { value: "configure", label: "Configuration" },
              { value: "runs", label: "Runs" },
            ]}
            value={activeView}
            onValueChange={(value) => navigate(`/agents/${canonicalAgentRef}/${value}`)}
          />
        </Tabs>
      )}

      {actionError && <p className="text-sm text-destructive">{actionError}</p>}
      {isPendingApproval && (
        <p className="text-sm text-amber-500">
          This agent is pending board approval and cannot be invoked yet.
        </p>
      )}

      {!isMobile && (
        <div
          className={cn(
            "sticky top-6 z-10 float-right transition-opacity duration-150",
            showConfigActionBar ? "opacity-100" : "opacity-0 pointer-events-none",
          )}
        >
          <div className="flex items-center gap-2 bg-background/90 backdrop-blur-sm border border-border rounded-lg px-3 py-1.5 shadow-lg">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => cancelConfigActionRef.current?.()}
              disabled={configSaving}
            >
              Cancel
            </Button>
            <Button size="sm" onClick={() => saveConfigActionRef.current?.()} disabled={configSaving}>
              {configSaving ? "Saving…" : "Save"}
            </Button>
          </div>
        </div>
      )}

      {isMobile && showConfigActionBar && (
        <div className="fixed inset-x-0 bottom-0 z-30 border-t border-border bg-background/95 backdrop-blur-sm">
          <div
            className="flex items-center justify-end gap-2 px-3 py-2"
            style={{ paddingBottom: "max(env(safe-area-inset-bottom), 0.5rem)" }}
          >
            <Button
              variant="ghost"
              size="sm"
              onClick={() => cancelConfigActionRef.current?.()}
              disabled={configSaving}
            >
              Cancel
            </Button>
            <Button size="sm" onClick={() => saveConfigActionRef.current?.()} disabled={configSaving}>
              {configSaving ? "Saving…" : "Save"}
            </Button>
          </div>
        </div>
      )}

      {activeView === "overview" && (
        <AgentOverview
          agent={agent}
          runs={heartbeats ?? []}
          assignedIssues={assignedIssues}
          runtimeState={runtimeState}
          agentId={agent.id}
          agentRouteId={canonicalAgentRef}
          reportsToAgent={reportsToAgent ?? null}
          directReports={directReports ?? []}
          companyId={resolvedCompanyId ?? undefined}
        />
      )}

      {activeView === "configure" && (
        <AgentConfigurePage
          agent={agent}
          agentId={agent.id}
          agentRouteId={canonicalAgentRef}
          companyId={resolvedCompanyId ?? undefined}
          onDirtyChange={setConfigDirty}
          onSaveActionChange={setSaveConfigAction}
          onCancelActionChange={setCancelConfigAction}
          onSavingChange={setConfigSaving}
          onConfigSaveError={setActionError}
          updatePermissions={updatePermissions}
        />
      )}

      {activeView === "runs" && (
        <RunsTab
          runs={heartbeats ?? []}
          companyId={resolvedCompanyId!}
          agentId={agent.id}
          agentRouteId={canonicalAgentRef}
          selectedRunId={urlRunId ?? null}
          adapterType={agent.adapterType}
        />
      )}

      {activeView === "attribution" && (
        <AttributionTab
          agentId={agent.id}
          agentRouteId={canonicalAgentRef}
          companyId={resolvedCompanyId ?? undefined}
        />
      )}
    </div>
  );
}
