import { useEffect, useRef, type ReactNode } from "react";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import type { Agent, Issue, LiveEvent } from "@hive/shared";
import { authApi } from "../api/auth";
import { useCompany } from "./CompanyContext";
import { useLiveFeed } from "./LiveFeedContext";
import type { ToastInput } from "./ToastContext";
import { useToast } from "./ToastContext";
import { queryKeys } from "../lib/queryKeys";

const TOAST_COOLDOWN_WINDOW_MS = 10_000;
const TOAST_COOLDOWN_MAX = 3;
const RECONNECT_SUPPRESS_MS = 2000;
/** After this many WebSocket reconnect attempts, fall back to SSE. */
const WS_FALLBACK_AFTER_ATTEMPTS = 3;
/**
 * Defer the first connection to the next macrotask so React 18 Strict Mode's
 * mount → immediate unmount → remount does not open a WebSocket and then close
 * it during the handshake (browser: "closed before the connection is established").
 */
const INITIAL_CONNECT_DELAY_MS = 0;

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function shortId(value: string) {
  return value.slice(0, 8);
}

function resolveAgentName(
  queryClient: QueryClient,
  companyId: string,
  agentId: string,
): string | null {
  const agents = queryClient.getQueryData<Agent[]>(queryKeys.agents.list(companyId));
  if (!agents) return null;
  const agent = agents.find((a) => a.id === agentId);
  return agent?.name ?? null;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + "\u2026";
}

function resolveActorLabel(
  queryClient: QueryClient,
  companyId: string,
  actorType: string | null,
  actorId: string | null,
): string {
  if (actorType === "agent" && actorId) {
    return resolveAgentName(queryClient, companyId, actorId) ?? `Agent ${shortId(actorId)}`;
  }
  if (actorType === "system") return "System";
  if (actorType === "user" && actorId) {
    return "Board";
  }
  return "Someone";
}

interface IssueToastContext {
  ref: string;
  title: string | null;
  label: string;
  href: string;
}

function resolveIssueQueryRefs(
  queryClient: QueryClient,
  companyId: string,
  issueId: string,
  details: Record<string, unknown> | null,
): string[] {
  const refs = new Set<string>([issueId]);
  const detailIssue = queryClient.getQueryData<Issue>(queryKeys.issues.detail(issueId));
  const listIssues = queryClient.getQueryData<Issue[]>(queryKeys.issues.list(companyId));
  const detailsIdentifier =
    readString(details?.identifier) ??
    readString(details?.issueIdentifier);

  if (detailsIdentifier) refs.add(detailsIdentifier);

  if (detailIssue?.id) refs.add(detailIssue.id);
  if (detailIssue?.identifier) refs.add(detailIssue.identifier);

  const listIssue = listIssues?.find((issue) => {
    if (issue.id === issueId) return true;
    if (issue.identifier && issue.identifier === issueId) return true;
    if (detailsIdentifier && issue.identifier === detailsIdentifier) return true;
    return false;
  });
  if (listIssue?.id) refs.add(listIssue.id);
  if (listIssue?.identifier) refs.add(listIssue.identifier);

  return Array.from(refs);
}

function resolveIssueToastContext(
  queryClient: QueryClient,
  companyId: string,
  issueId: string,
  details: Record<string, unknown> | null,
): IssueToastContext {
  const issueRefs = resolveIssueQueryRefs(queryClient, companyId, issueId, details);
  const detailIssue = issueRefs
    .map((ref) => queryClient.getQueryData<Issue>(queryKeys.issues.detail(ref)))
    .find((issue): issue is Issue => !!issue);
  const listIssue = queryClient
    .getQueryData<Issue[]>(queryKeys.issues.list(companyId))
    ?.find((issue) => issueRefs.some((ref) => issue.id === ref || issue.identifier === ref));
  const cachedIssue = detailIssue ?? listIssue ?? null;
  const ref =
    readString(details?.identifier) ??
    readString(details?.issueIdentifier) ??
    cachedIssue?.identifier ??
    `Issue ${shortId(issueId)}`;
  const title =
    readString(details?.title) ??
    readString(details?.issueTitle) ??
    cachedIssue?.title ??
    null;
  return {
    ref,
    title,
    label: title ? `${ref} - ${truncate(title, 72)}` : ref,
    href: `/issues/${cachedIssue?.identifier ?? issueId}`,
  };
}

const ISSUE_TOAST_ACTIONS = new Set(["issue.created", "issue.updated", "issue.comment_added"]);
const AGENT_TOAST_STATUSES = new Set(["running", "error"]);
const TERMINAL_RUN_STATUSES = new Set(["succeeded", "failed", "timed_out", "cancelled"]);

function describeIssueUpdate(details: Record<string, unknown> | null): string | null {
  if (!details) return null;
  const changes: string[] = [];
  if (typeof details.status === "string") changes.push(`status -> ${details.status.replace(/_/g, " ")}`);
  if (typeof details.priority === "string") changes.push(`priority -> ${details.priority}`);
  if (typeof details.assigneeAgentId === "string" || typeof details.assigneeUserId === "string") {
    changes.push("reassigned");
  } else if (details.assigneeAgentId === null || details.assigneeUserId === null) {
    changes.push("unassigned");
  }
  if (details.reopened === true) {
    const from = readString(details.reopenedFrom);
    changes.push(from ? `reopened from ${from.replace(/_/g, " ")}` : "reopened");
  }
  if (typeof details.title === "string") changes.push("title changed");
  if (typeof details.description === "string") changes.push("description changed");
  if (changes.length > 0) return changes.join(", ");
  return null;
}

function buildActivityToast(
  queryClient: QueryClient,
  companyId: string,
  payload: Record<string, unknown>,
  currentActor: { userId: string | null; agentId: string | null },
): ToastInput | null {
  const entityType = readString(payload.entityType);
  const entityId = readString(payload.entityId);
  const action = readString(payload.action);
  const details = readRecord(payload.details);
  const actorId = readString(payload.actorId);
  const actorType = readString(payload.actorType);

  if (entityType !== "issue" || !entityId || !action || !ISSUE_TOAST_ACTIONS.has(action)) {
    return null;
  }

  const issue = resolveIssueToastContext(queryClient, companyId, entityId, details);
  const actor = resolveActorLabel(queryClient, companyId, actorType, actorId);
  const isSelfActivity =
    (actorType === "user" && !!currentActor.userId && actorId === currentActor.userId) ||
    (actorType === "agent" && !!currentActor.agentId && actorId === currentActor.agentId);
  if (isSelfActivity) return null;

  if (action === "issue.created") {
    return {
      title: `${actor} created ${issue.ref}`,
      body: issue.title ? truncate(issue.title, 96) : undefined,
      tone: "success",
      action: { label: `View ${issue.ref}`, href: issue.href },
      dedupeKey: `activity:${action}:${entityId}`,
    };
  }

  if (action === "issue.updated") {
    if (readString(details?.source) === "comment") {
      // Comment-driven updates emit a paired comment event; show one combined toast on the comment event.
      return null;
    }
    const changeDesc = describeIssueUpdate(details);
    const body = changeDesc
      ? issue.title
        ? `${truncate(issue.title, 64)} - ${changeDesc}`
        : changeDesc
      : issue.title
        ? truncate(issue.title, 96)
        : issue.label;
    return {
      title: `${actor} updated ${issue.ref}`,
      body: truncate(body, 100),
      tone: "info",
      action: { label: `View ${issue.ref}`, href: issue.href },
      dedupeKey: `activity:${action}:${entityId}`,
    };
  }

  const commentId = readString(details?.commentId);
  const bodySnippet = readString(details?.bodySnippet);
  const reopened = details?.reopened === true;
  const updated = details?.updated === true;
  const reopenedFrom = readString(details?.reopenedFrom);
  const reopenedLabel = reopened
    ? reopenedFrom
      ? `reopened from ${reopenedFrom.replace(/_/g, " ")}`
      : "reopened"
    : null;
  const title = reopened
    ? `${actor} reopened and commented on ${issue.ref}`
    : updated
      ? `${actor} commented and updated ${issue.ref}`
      : `${actor} commented on ${issue.ref}`;
  const body = bodySnippet
    ? reopenedLabel
      ? `${reopenedLabel} - ${bodySnippet.replace(/^#+\s*/m, "").replace(/\n/g, " ")}`
      : bodySnippet.replace(/^#+\s*/m, "").replace(/\n/g, " ")
    : reopenedLabel
      ? issue.title
        ? `${reopenedLabel} - ${issue.title}`
        : reopenedLabel
      : issue.title ?? undefined;
  return {
    title,
    body: body ? truncate(body, 96) : undefined,
    tone: "info",
    action: { label: `View ${issue.ref}`, href: issue.href },
    dedupeKey: `activity:${action}:${entityId}:${commentId ?? "na"}`,
  };
}

function buildJoinRequestToast(
  payload: Record<string, unknown>,
): ToastInput | null {
  const entityType = readString(payload.entityType);
  const action = readString(payload.action);
  const entityId = readString(payload.entityId);
  const details = readRecord(payload.details);

  if (entityType !== "join_request" || !action || !entityId) return null;
  if (action !== "join.requested" && action !== "join.request_replayed") return null;

  const requestType = readString(details?.requestType);
  const label = requestType === "agent" ? "Agent" : "Someone";

  return {
    title: `${label} wants to join`,
    body: "A new join request is waiting for approval.",
    tone: "info",
    action: { label: "View inbox", href: "/inbox/unread" },
    dedupeKey: `join-request:${entityId}`,
  };
}

function buildAgentStatusToast(
  payload: Record<string, unknown>,
  nameOf: (id: string) => string | null,
  queryClient: QueryClient,
  companyId: string,
): ToastInput | null {
  const agentId = readString(payload.agentId);
  const status = readString(payload.status);
  if (!agentId || !status || !AGENT_TOAST_STATUSES.has(status)) return null;

  const tone = status === "error" ? "error" : "info";
  const name = nameOf(agentId) ?? `Agent ${shortId(agentId)}`;
  const title =
    status === "running"
      ? `${name} started`
      : `${name} errored`;

  const agents = queryClient.getQueryData<Agent[]>(queryKeys.agents.list(companyId));
  const agent = agents?.find((a) => a.id === agentId);
  const body = agent?.title ?? undefined;

  return {
    title,
    body,
    tone,
    action: { label: "View agent", href: `/agents/${agentId}` },
    dedupeKey: `agent-status:${agentId}:${status}`,
  };
}

function buildRunStatusToast(
  payload: Record<string, unknown>,
  nameOf: (id: string) => string | null,
): ToastInput | null {
  const runId = readString(payload.runId);
  const agentId = readString(payload.agentId);
  const status = readString(payload.status);
  if (!runId || !agentId || !status || !TERMINAL_RUN_STATUSES.has(status)) return null;

  const error = readString(payload.error);
  const triggerDetail = readString(payload.triggerDetail);
  const name = nameOf(agentId) ?? `Agent ${shortId(agentId)}`;
  const tone = status === "succeeded" ? "success" : status === "cancelled" ? "warn" : "error";
  const statusLabel =
    status === "succeeded" ? "succeeded"
      : status === "failed" ? "failed"
        : status === "timed_out" ? "timed out"
          : "cancelled";
  const title = `${name} run ${statusLabel}`;

  let body: string | undefined;
  if (error) {
    body = truncate(error, 100);
  } else if (triggerDetail) {
    body = `Trigger: ${triggerDetail}`;
  }

  return {
    title,
    body,
    tone,
    ttlMs: status === "succeeded" ? 5000 : 7000,
    action: { label: "View run", href: `/agents/${agentId}/runs/${runId}` },
    dedupeKey: `run-status:${runId}:${status}`,
  };
}

function invalidateHeartbeatQueries(
  queryClient: ReturnType<typeof useQueryClient>,
  companyId: string,
  payload: Record<string, unknown>,
) {
  queryClient.invalidateQueries({ queryKey: queryKeys.liveRuns(companyId) });
  queryClient.invalidateQueries({ queryKey: queryKeys.heartbeats(companyId) });
  queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(companyId) });
  queryClient.invalidateQueries({ queryKey: queryKeys.dashboard(companyId) });
  queryClient.invalidateQueries({ queryKey: queryKeys.costs(companyId) });
  queryClient.invalidateQueries({ queryKey: queryKeys.sidebarBadges(companyId) });

  const agentId = readString(payload.agentId);
  if (agentId) {
    queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agentId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.heartbeats(companyId, agentId) });
  }
}

function invalidateActivityQueries(
  queryClient: ReturnType<typeof useQueryClient>,
  companyId: string,
  payload: Record<string, unknown>,
) {
  queryClient.invalidateQueries({ queryKey: queryKeys.activity(companyId) });
  queryClient.invalidateQueries({ queryKey: queryKeys.dashboard(companyId) });
  queryClient.invalidateQueries({ queryKey: queryKeys.sidebarBadges(companyId) });

  const entityType = readString(payload.entityType);
  const entityId = readString(payload.entityId);

  if (entityType === "issue") {
    queryClient.invalidateQueries({ queryKey: queryKeys.issues.list(companyId) });
    if (entityId) {
      const details = readRecord(payload.details);
      const issueRefs = resolveIssueQueryRefs(queryClient, companyId, entityId, details);
      for (const ref of issueRefs) {
        queryClient.invalidateQueries({ queryKey: queryKeys.issues.detail(ref) });
        queryClient.invalidateQueries({ queryKey: queryKeys.issues.comments(ref) });
        queryClient.invalidateQueries({ queryKey: queryKeys.issues.activity(ref) });
        queryClient.invalidateQueries({ queryKey: queryKeys.issues.runs(ref) });
        queryClient.invalidateQueries({ queryKey: queryKeys.issues.liveRuns(ref) });
        queryClient.invalidateQueries({ queryKey: queryKeys.issues.activeRun(ref) });
      }
    }
    return;
  }

  if (entityType === "agent") {
    queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(companyId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.org(companyId) });
    if (entityId) {
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(entityId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.heartbeats(companyId, entityId) });
    }
    return;
  }

  if (entityType === "project") {
    queryClient.invalidateQueries({ queryKey: queryKeys.projects.list(companyId) });
    if (entityId) queryClient.invalidateQueries({ queryKey: queryKeys.projects.detail(entityId) });
    return;
  }

  if (entityType === "goal") {
    queryClient.invalidateQueries({ queryKey: queryKeys.goals.list(companyId) });
    if (entityId) queryClient.invalidateQueries({ queryKey: queryKeys.goals.detail(entityId) });
    return;
  }

  if (entityType === "approval") {
    queryClient.invalidateQueries({ queryKey: queryKeys.approvals.list(companyId) });
    return;
  }

  if (entityType === "join_request") {
    queryClient.invalidateQueries({ queryKey: queryKeys.access.joinRequests(companyId) });
    return;
  }

  if (entityType === "cost_event") {
    queryClient.invalidateQueries({ queryKey: queryKeys.costs(companyId) });
    return;
  }

  if (entityType === "company") {
    queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
  }
}

interface ToastGate {
  cooldownHits: Map<string, number[]>;
  suppressUntil: number;
}

function shouldSuppressToast(gate: ToastGate, category: string): boolean {
  const now = Date.now();
  if (now < gate.suppressUntil) return true;

  const hits = gate.cooldownHits.get(category);
  if (!hits) return false;

  const recent = hits.filter((t) => now - t < TOAST_COOLDOWN_WINDOW_MS);
  gate.cooldownHits.set(category, recent);
  return recent.length >= TOAST_COOLDOWN_MAX;
}

function recordToastHit(gate: ToastGate, category: string) {
  const now = Date.now();
  const hits = gate.cooldownHits.get(category) ?? [];
  hits.push(now);
  gate.cooldownHits.set(category, hits);
}

function gatedPushToast(
  gate: ToastGate,
  pushToast: (toast: ToastInput) => string | null,
  category: string,
  toast: ToastInput,
) {
  if (shouldSuppressToast(gate, category)) return;
  const id = pushToast(toast);
  if (id !== null) recordToastHit(gate, category);
}

function handleLiveEvent(
  queryClient: QueryClient,
  expectedCompanyId: string,
  event: LiveEvent,
  pushToast: (toast: ToastInput) => string | null,
  gate: ToastGate,
  currentActor: { userId: string | null; agentId: string | null },
) {
  if (event.companyId !== expectedCompanyId) return;

  const nameOf = (id: string) => resolveAgentName(queryClient, expectedCompanyId, id);
  const payload = event.payload ?? {};
  if (event.type === "heartbeat.run.log") {
    return;
  }

  if (event.type === "heartbeat.run.queued" || event.type === "heartbeat.run.status") {
    invalidateHeartbeatQueries(queryClient, expectedCompanyId, payload);
    if (event.type === "heartbeat.run.status") {
      const toast = buildRunStatusToast(payload, nameOf);
      if (toast) gatedPushToast(gate, pushToast, "run-status", toast);
    }
    return;
  }

  if (event.type === "heartbeat.run.event") {
    return;
  }

  if (event.type === "agent.status") {
    queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(expectedCompanyId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.dashboard(expectedCompanyId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.org(expectedCompanyId) });
    const agentId = readString(payload.agentId);
    if (agentId) queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agentId) });
    const toast = buildAgentStatusToast(payload, nameOf, queryClient, expectedCompanyId);
    if (toast) gatedPushToast(gate, pushToast, "agent-status", toast);
    return;
  }

  if (event.type === "worker.link.connected" || event.type === "worker.link.disconnected") {
    void queryClient.refetchQueries({ queryKey: queryKeys.workers.overview(expectedCompanyId) });
    return;
  }

  if (event.type === "worker.pairing.pending") {
    queryClient.invalidateQueries({ queryKey: queryKeys.workers.pairingRequests(expectedCompanyId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.workers.overview(expectedCompanyId) });
    const agentName = readString(payload.agentName) ?? "Managed worker";
    const pairingAgentId = readString(payload.agentId);
    gatedPushToast(gate, pushToast, "worker-pairing", {
      title: "Pairing needs your OK",
      body: `${agentName} — approve the request on Workers to finish connecting this machine.`,
      tone: "info",
      ttlMs: 12_000,
      action: {
        label: "Review on Workers",
        href: pairingAgentId ? `/workers?enroll=${encodeURIComponent(pairingAgentId)}` : "/workers",
      },
    });
    return;
  }

  if (event.type === "worker.drone.registered") {
    void queryClient.refetchQueries({ queryKey: queryKeys.workers.overview(expectedCompanyId) });
    const host = readString(payload.hostname);
    const first = payload.firstRegistration === true;
    gatedPushToast(gate, pushToast, "worker-drone-registered", {
      title: first ? "Drone enrolled" : "Drone reconnected",
      body: host
        ? `${first ? "New host" : "Host"} “${host}” — open Workers to attach board identities if needed.`
        : `${first ? "A new drone finished bootstrap" : "A drone sent hello"} — open Workers to attach identities if needed.`,
      tone: "info",
      ttlMs: 10_000,
      action: { label: "Open Workers", href: "/workers" },
    });
    return;
  }

  if (event.type === "activity.logged") {
    invalidateActivityQueries(queryClient, expectedCompanyId, payload);
    const action = readString(payload.action);
    const toast =
      buildActivityToast(queryClient, expectedCompanyId, payload, currentActor) ??
      buildJoinRequestToast(payload);
    if (toast) gatedPushToast(gate, pushToast, `activity:${action ?? "unknown"}`, toast);
  }
}

export function LiveUpdatesProvider({ children }: { children: ReactNode }) {
  const { selectedCompanyId } = useCompany();
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const { append: appendToFeed, resetForCompanySwitch: resetLiveFeedForCompanySwitch } =
    useLiveFeed();
  const gateRef = useRef<ToastGate>({ cooldownHits: new Map(), suppressUntil: 0 });
  const prevCompanyIdRef = useRef<string | null>(null);
  const { data: session } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
    retry: false,
  });
  const currentUserId = session?.user?.id ?? session?.session?.userId ?? null;

  const useSSERef = useRef(false);

  /** Keep latest callbacks / ids without re-subscribing live transport (avoids closing WS mid-handshake). */
  const queryClientRef = useRef(queryClient);
  queryClientRef.current = queryClient;
  const pushToastRef = useRef(pushToast);
  pushToastRef.current = pushToast;
  const appendToFeedRef = useRef(appendToFeed);
  appendToFeedRef.current = appendToFeed;
  const resetLiveFeedRef = useRef(resetLiveFeedForCompanySwitch);
  resetLiveFeedRef.current = resetLiveFeedForCompanySwitch;
  const currentUserIdRef = useRef(currentUserId);
  currentUserIdRef.current = currentUserId;

  useEffect(() => {
    if (!selectedCompanyId) return;

    if (prevCompanyIdRef.current !== null && prevCompanyIdRef.current !== selectedCompanyId) {
      resetLiveFeedRef.current();
    }
    prevCompanyIdRef.current = selectedCompanyId;
    useSSERef.current = false;

    let closed = false;
    let reconnectAttempt = 0;
    let reconnectTimer: number | null = null;
    let initialConnectTimer: number | null = null;
    let socket: WebSocket | null = null;
    let eventSource: EventSource | null = null;

    const clearReconnect = () => {
      if (reconnectTimer !== null) {
        window.clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
    };

    const processEvent = (parsed: LiveEvent) => {
      handleLiveEvent(queryClientRef.current, selectedCompanyId, parsed, pushToastRef.current, gateRef.current, {
        userId: currentUserIdRef.current,
        agentId: null,
      });
      if (parsed.companyId === selectedCompanyId) {
        appendToFeedRef.current(parsed, "live");
      }
    };

    const scheduleReconnect = () => {
      if (closed) return;
      reconnectAttempt += 1;
      if (reconnectAttempt >= WS_FALLBACK_AFTER_ATTEMPTS) {
        useSSERef.current = true;
      }
      const delayMs = Math.min(15000, 1000 * 2 ** Math.min(reconnectAttempt - 1, 4));
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, delayMs);
    };

    const connect = () => {
      if (closed) return;

      if (useSSERef.current) {
        const url = `${window.location.origin}/api/companies/${encodeURIComponent(selectedCompanyId)}/events`;
        eventSource = new EventSource(url);
        eventSource.onmessage = (ev: MessageEvent) => {
          const raw = typeof ev.data === "string" ? ev.data : "";
          if (!raw || raw.startsWith(":")) return;
          try {
            const parsed = JSON.parse(raw) as LiveEvent;
            processEvent(parsed);
          } catch {
            // Ignore non-JSON payloads.
          }
        };
        eventSource.onerror = () => {
          eventSource?.close();
          eventSource = null;
          if (!closed) scheduleReconnect();
        };
        return;
      }

      const protocol = window.location.protocol === "https:" ? "wss" : "ws";
      const url = `${protocol}://${window.location.host}/api/companies/${encodeURIComponent(selectedCompanyId)}/events/ws`;
      socket = new WebSocket(url);

      socket.onopen = () => {
        if (reconnectAttempt > 0) {
          gateRef.current.suppressUntil = Date.now() + RECONNECT_SUPPRESS_MS;
        }
        reconnectAttempt = 0;
      };

      socket.onmessage = (message) => {
        const raw = typeof message.data === "string" ? message.data : "";
        if (!raw) return;
        try {
          const parsed = JSON.parse(raw) as LiveEvent;
          processEvent(parsed);
        } catch {
          // Ignore non-JSON payloads.
        }
      };

      socket.onerror = () => {
        socket?.close();
      };

      socket.onclose = () => {
        if (closed) return;
        scheduleReconnect();
      };
    };

    initialConnectTimer = window.setTimeout(() => {
      initialConnectTimer = null;
      connect();
    }, INITIAL_CONNECT_DELAY_MS);

    return () => {
      closed = true;
      clearReconnect();
      if (initialConnectTimer !== null) {
        window.clearTimeout(initialConnectTimer);
        initialConnectTimer = null;
      }
      if (socket) {
        socket.onopen = null;
        socket.onmessage = null;
        socket.onerror = null;
        socket.onclose = null;
        socket.close(1000, "provider_unmount");
      }
      if (eventSource) {
        eventSource.onmessage = null;
        eventSource.onerror = null;
        eventSource.close();
      }
    };
  }, [selectedCompanyId]);

  return <>{children}</>;
}
