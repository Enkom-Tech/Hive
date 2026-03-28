import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useNavigate, useBeforeUnload } from "@/lib/router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { agentsApi } from "../api/agents";
import { heartbeatsApi } from "../api/heartbeats";
import { issuesApi } from "../api/issues";
import { usePanel } from "../context/PanelContext";
import { useSidebar } from "../context/SidebarContext";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { isUuidLike, type Agent, type HeartbeatRun } from "@hive/shared";
import { agentRouteRef } from "../lib/utils";
import { parseAgentDetailView, type AgentDetailView } from "../components/agent-detail/agent-detail-internals.js";

export function useAgentDetailPage() {
  const { companyPrefix, agentId, tab: urlTab, runId: urlRunId } = useParams<{
    companyPrefix?: string;
    agentId: string;
    tab?: string;
    runId?: string;
  }>();
  const { companies, selectedCompanyId, setSelectedCompanyId } = useCompany();
  const { closePanel } = usePanel();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [actionError, setActionError] = useState<string | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const activeView = urlRunId ? ("runs" as AgentDetailView) : parseAgentDetailView(urlTab ?? null);
  const [configDirty, setConfigDirty] = useState(false);
  const [configSaving, setConfigSaving] = useState(false);
  const saveConfigActionRef = useRef<(() => void) | null>(null);
  const cancelConfigActionRef = useRef<(() => void) | null>(null);
  const { isMobile } = useSidebar();
  const routeAgentRef = agentId ?? "";
  const routeCompanyId = useMemo(() => {
    if (!companyPrefix) return null;
    const requestedPrefix = companyPrefix.toUpperCase();
    return companies.find((company) => company.issuePrefix.toUpperCase() === requestedPrefix)?.id ?? null;
  }, [companies, companyPrefix]);
  const lookupCompanyId = routeCompanyId ?? selectedCompanyId ?? undefined;
  const canFetchAgent = routeAgentRef.length > 0 && (isUuidLike(routeAgentRef) || Boolean(lookupCompanyId));
  const setSaveConfigAction = useCallback((fn: (() => void) | null) => {
    saveConfigActionRef.current = fn;
  }, []);
  const setCancelConfigAction = useCallback((fn: (() => void) | null) => {
    cancelConfigActionRef.current = fn;
  }, []);

  const { data: agent, isLoading, error } = useQuery({
    queryKey: [...queryKeys.agents.detail(routeAgentRef), lookupCompanyId ?? null],
    queryFn: () => agentsApi.get(routeAgentRef, lookupCompanyId),
    enabled: canFetchAgent,
  });
  const resolvedCompanyId = agent?.companyId ?? selectedCompanyId;
  const canonicalAgentRef = agent ? agentRouteRef(agent) : routeAgentRef;
  const agentLookupRef = agent?.id ?? routeAgentRef;
  const resolvedAgentId = agent?.id ?? null;

  const { data: runtimeState } = useQuery({
    queryKey: queryKeys.agents.runtimeState(resolvedAgentId ?? routeAgentRef),
    queryFn: () => agentsApi.runtimeState(resolvedAgentId!, resolvedCompanyId ?? undefined),
    enabled: Boolean(resolvedAgentId),
  });

  const { data: heartbeats } = useQuery({
    queryKey: queryKeys.heartbeats(resolvedCompanyId!, agent?.id ?? undefined),
    queryFn: () => heartbeatsApi.list(resolvedCompanyId!, agent?.id ?? undefined),
    enabled: !!resolvedCompanyId && !!agent?.id,
  });

  const { data: allIssues } = useQuery({
    queryKey: queryKeys.issues.list(resolvedCompanyId!),
    queryFn: () => issuesApi.list(resolvedCompanyId!),
    enabled: !!resolvedCompanyId,
  });

  const { data: allAgents } = useQuery({
    queryKey: queryKeys.agents.list(resolvedCompanyId!),
    queryFn: () => agentsApi.list(resolvedCompanyId!),
    enabled: !!resolvedCompanyId,
  });

  const assignedIssues = (allIssues ?? [])
    .filter((i) => i.assigneeAgentId === agent?.id)
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  const reportsToAgent = (allAgents ?? []).find((a) => a.id === agent?.reportsTo);
  const directReports = (allAgents ?? []).filter((a) => a.reportsTo === agent?.id && a.status !== "terminated");
  const mobileLiveRun = useMemo(
    () => (heartbeats ?? []).find((r) => r.status === "running" || r.status === "queued") ?? null,
    [heartbeats],
  );

  useEffect(() => {
    if (!agent) return;
    if (urlRunId) {
      if (routeAgentRef !== canonicalAgentRef) {
        navigate(`/agents/${canonicalAgentRef}/runs/${urlRunId}`, { replace: true });
      }
      return;
    }
    const canonicalTab =
      activeView === "configure" ? "configure" : activeView === "runs" ? "runs" : "overview";
    if (routeAgentRef !== canonicalAgentRef || urlTab !== canonicalTab) {
      navigate(`/agents/${canonicalAgentRef}/${canonicalTab}`, { replace: true });
      return;
    }
  }, [agent, routeAgentRef, canonicalAgentRef, urlRunId, urlTab, activeView, navigate]);

  useEffect(() => {
    if (!agent?.companyId || agent.companyId === selectedCompanyId) return;
    setSelectedCompanyId(agent.companyId, { source: "route_sync" });
  }, [agent?.companyId, selectedCompanyId, setSelectedCompanyId]);

  const agentAction = useMutation({
    mutationFn: async (action: "invoke" | "pause" | "resume" | "terminate") => {
      if (!agentLookupRef) return Promise.reject(new Error("No agent reference"));
      switch (action) {
        case "invoke":
          return agentsApi.invoke(agentLookupRef, resolvedCompanyId ?? undefined);
        case "pause":
          return agentsApi.pause(agentLookupRef, resolvedCompanyId ?? undefined);
        case "resume":
          return agentsApi.resume(agentLookupRef, resolvedCompanyId ?? undefined);
        case "terminate":
          return agentsApi.terminate(agentLookupRef, resolvedCompanyId ?? undefined);
      }
    },
    onSuccess: (data, action) => {
      setActionError(null);
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(routeAgentRef) });
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agentLookupRef) });
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.runtimeState(agentLookupRef) });
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.taskSessions(agentLookupRef) });
      if (resolvedCompanyId) {
        queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(resolvedCompanyId) });
        if (agent?.id) {
          queryClient.invalidateQueries({ queryKey: queryKeys.heartbeats(resolvedCompanyId, agent.id) });
        }
      }
      if (action === "invoke" && data && typeof data === "object" && "id" in data) {
        navigate(`/agents/${canonicalAgentRef}/runs/${(data as HeartbeatRun).id}`);
      }
    },
    onError: (err) => {
      setActionError(err instanceof Error ? err.message : "Action failed");
    },
  });

  const updateIcon = useMutation({
    mutationFn: (icon: string) => agentsApi.update(agentLookupRef, { icon }, resolvedCompanyId ?? undefined),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(routeAgentRef) });
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agentLookupRef) });
      if (resolvedCompanyId) {
        queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(resolvedCompanyId) });
      }
    },
  });

  const resetTaskSession = useMutation({
    mutationFn: (taskKey: string | null) =>
      agentsApi.resetSession(agentLookupRef, taskKey, resolvedCompanyId ?? undefined),
    onSuccess: () => {
      setActionError(null);
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.runtimeState(agentLookupRef) });
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.taskSessions(agentLookupRef) });
    },
    onError: (err) => {
      setActionError(err instanceof Error ? err.message : "Failed to reset session");
    },
  });

  const updatePermissions = useMutation({
    mutationFn: (canCreateAgents: boolean) =>
      agentsApi.updatePermissions(agentLookupRef, { canCreateAgents }, resolvedCompanyId ?? undefined),
    onSuccess: () => {
      setActionError(null);
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(routeAgentRef) });
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agentLookupRef) });
      if (resolvedCompanyId) {
        queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(resolvedCompanyId) });
      }
    },
    onError: (err) => {
      setActionError(err instanceof Error ? err.message : "Failed to update permissions");
    },
  });

  useEffect(() => {
    const crumbs: { label: string; href?: string }[] = [{ label: "Agents", href: "/agents" }];
    const agentName = agent?.name ?? routeAgentRef ?? "Agent";
    if (activeView === "overview" && !urlRunId) {
      crumbs.push({ label: agentName });
    } else {
      crumbs.push({ label: agentName, href: `/agents/${canonicalAgentRef}/overview` });
      if (urlRunId) {
        crumbs.push({ label: "Runs", href: `/agents/${canonicalAgentRef}/runs` });
        crumbs.push({ label: `Run ${urlRunId.slice(0, 8)}` });
      } else if (activeView === "configure") {
        crumbs.push({ label: "Configuration" });
      } else if (activeView === "runs") {
        crumbs.push({ label: "Runs" });
      } else if (activeView === "attribution") {
        crumbs.push({ label: "Attribution" });
      } else {
        crumbs.push({ label: "Overview" });
      }
    }
    setBreadcrumbs(crumbs);
  }, [setBreadcrumbs, agent, routeAgentRef, canonicalAgentRef, activeView, urlRunId]);

  useEffect(() => {
    closePanel();
    return () => closePanel();
  }, [closePanel]);

  useBeforeUnload(
    useCallback(
      (event) => {
        if (!configDirty) return;
        event.preventDefault();
        event.returnValue = "";
      },
      [configDirty],
    ),
  );

  return {
    urlRunId,
    urlTab,
    setActionError,
    agent: agent as Agent | undefined,
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
    routeAgentRef,
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
  };
}
