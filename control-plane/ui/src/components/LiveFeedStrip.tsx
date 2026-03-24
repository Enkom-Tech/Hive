import { useEffect, useMemo } from "react";
import { Link } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import {
  ChevronDown,
  ChevronUp,
  History,
  Play,
  Bot,
  Trash2,
  Rss,
} from "lucide-react";
import type { LiveFeedItem, LiveFeedFilter } from "@hive/shared";
import { LIVE_FEED_FILTERS } from "@hive/shared";
import { useCompany } from "../context/CompanyContext";
import { useLiveFeed } from "../context/LiveFeedContext";
import { useSidebar } from "../context/SidebarContext";
import { agentsApi } from "../api/agents";
import { queryKeys } from "../lib/queryKeys";
import { timeAgo } from "../lib/timeAgo";
import { cn } from "../lib/utils";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ScrollArea } from "@/components/ui/scroll-area";

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function shortId(value: string) {
  return value.slice(0, 8);
}

function LiveFeedItemRow({
  item,
  agentNameMap,
}: {
  item: LiveFeedItem;
  agentNameMap: Map<string, string>;
}) {
  const { kind, event } = item;
  const payload = event.payload ?? {};
  const createdAt = event.createdAt;

  if (kind === "activity") {
    const entityType = readString(payload.entityType) ?? "";
    const entityId = readString(payload.entityId) ?? "";
    const action = readString(payload.action) ?? "updated";
    const identifier =
      readString(payload.identifier) ?? readString(payload.issueIdentifier) ?? entityId;
    const href =
      entityType === "issue"
        ? `/issues/${identifier}`
        : entityType === "agent"
          ? `/agents/${entityId}`
          : entityType === "project"
            ? `/projects/${entityId}`
            : entityType === "goal"
              ? `/goals/${entityId}`
              : entityType === "approval"
                ? `/approvals/${entityId}`
                : null;
    const label =
      entityType === "issue"
        ? identifier
        : entityType === "agent"
          ? agentNameMap.get(entityId) ?? `Agent ${shortId(entityId)}`
          : entityId.slice(0, 8);
    const verb = action.replace(/[._]/g, " ");
    return (
      <div className="flex items-center gap-2 px-3 py-1.5 text-sm border-b border-border/50 last:border-b-0">
        <History className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-muted-foreground">
          {verb}
          {label && (
            <>
              {" "}
              {href ? (
                <Link
                  to={href}
                  className="font-medium text-foreground hover:underline truncate inline-block max-w-full align-bottom cursor-pointer"
                >
                  {label}
                </Link>
              ) : (
                <span className="font-medium text-foreground">{label}</span>
              )}
            </>
          )}
        </span>
        <span className="text-xs text-muted-foreground shrink-0">{timeAgo(createdAt)}</span>
      </div>
    );
  }

  if (kind === "run_status") {
    const runId = readString(payload.runId);
    const agentId = readString(payload.agentId);
    const status = readString(payload.status) ?? "unknown";
    const name = agentId ? agentNameMap.get(agentId) ?? `Agent ${shortId(agentId)}` : "Run";
    const statusLabel =
      status === "succeeded"
        ? "succeeded"
        : status === "failed"
          ? "failed"
          : status === "timed_out"
            ? "timed out"
            : status === "cancelled"
              ? "cancelled"
              : status === "queued"
                ? "queued"
                : status;
    const href =
      agentId && runId ? `/agents/${agentId}/runs/${runId}` : agentId ? `/agents/${agentId}` : null;
    return (
      <div className="flex items-center gap-2 px-3 py-1.5 text-sm border-b border-border/50 last:border-b-0">
        <Play className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-muted-foreground">
          Run {statusLabel}
          {name && (
            <>
              {" — "}
              {href ? (
                <Link
                  to={href}
                  className="font-medium text-foreground hover:underline cursor-pointer"
                >
                  {name}
                </Link>
              ) : (
                <span className="font-medium text-foreground">{name}</span>
              )}
            </>
          )}
        </span>
        <span className="text-xs text-muted-foreground shrink-0">{timeAgo(createdAt)}</span>
      </div>
    );
  }

  if (kind === "agent_status") {
    const agentId = readString(payload.agentId);
    const status = readString(payload.status) ?? "";
    const name = agentId ? agentNameMap.get(agentId) ?? `Agent ${shortId(agentId)}` : "Agent";
    const label = status === "running" ? "started" : status === "error" ? "errored" : status;
    const href = agentId ? `/agents/${agentId}` : null;
    return (
      <div className="flex items-center gap-2 px-3 py-1.5 text-sm border-b border-border/50 last:border-b-0">
        <Bot className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-muted-foreground">
          {name}
          {" — "}
          {href ? (
            <Link to={href} className="font-medium text-foreground hover:underline cursor-pointer">
              {label}
            </Link>
          ) : (
            <span className="font-medium text-foreground">{label}</span>
          )}
        </span>
        <span className="text-xs text-muted-foreground shrink-0">{timeAgo(createdAt)}</span>
      </div>
    );
  }

  return null;
}

export function LiveFeedStrip() {
  const { selectedCompanyId, selectedCompany } = useCompany();
  const { isMobile } = useSidebar();
  const {
    items,
    filter,
    setFilter,
    clear,
    hydrate,
    hydratedForCompanyId,
    stripOpen,
    setStripOpen,
    getFilteredItems,
  } = useLiveFeed();

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId ?? ""),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId && stripOpen,
  });

  const agentNameMap = useMemo(() => {
    const m = new Map<string, string>();
    for (const a of agents ?? []) m.set(a.id, a.name);
    return m;
  }, [agents]);

  const filteredItems = useMemo(() => getFilteredItems(), [getFilteredItems, items, filter]);

  useEffect(() => {
    if (!stripOpen || !selectedCompanyId) return;
    if (hydratedForCompanyId === selectedCompanyId) return;
    void hydrate(selectedCompanyId);
  }, [stripOpen, selectedCompanyId, hydratedForCompanyId, hydrate]);

  if (!selectedCompanyId) return null;

  return (
    <aside
      aria-label="Live Feed"
      className={cn(
        "fixed left-0 right-0 z-30 flex flex-col border-t border-border bg-card/95 backdrop-blur supports-backdrop-filter:bg-card/80",
        "bottom-0 md:bottom-0",
        isMobile && "bottom-20",
      )}
    >
        <div className="flex items-center gap-2 px-3 py-2 border-b border-border min-h-11">
        <button
          type="button"
          onClick={() => setStripOpen(!stripOpen)}
          className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm font-medium hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring cursor-pointer"
          aria-expanded={stripOpen}
          aria-controls="live-feed-list"
        >
          <Rss className="h-4 w-4 text-muted-foreground" />
          <span>Live Feed</span>
          {stripOpen ? (
            <ChevronDown className="h-4 w-4 text-muted-foreground" aria-hidden />
          ) : (
            <ChevronUp className="h-4 w-4 text-muted-foreground" aria-hidden />
          )}
        </button>
        <span className="text-xs text-muted-foreground" aria-live="polite">
          {items.length} item{items.length !== 1 ? "s" : ""}
        </span>
        {stripOpen && (
          <>
            <Select
              value={filter}
              onValueChange={(v) => setFilter(v as LiveFeedFilter)}
            >
              <SelectTrigger size="sm" className="w-[110px] h-8">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {LIVE_FEED_FILTERS.map((f) => (
                  <SelectItem key={f} value={f}>
                    {f === "all" ? "All" : f.charAt(0).toUpperCase() + f.slice(1)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-8 gap-1.5 text-muted-foreground"
              onClick={() => clear(selectedCompanyId)}
              aria-label="Clear feed"
            >
              <Trash2 className="h-3.5 w-3.5" />
              Clear
            </Button>
          </>
        )}
      </div>
      {stripOpen && (
        <ScrollArea
          id="live-feed-list"
          role="list"
          aria-live="polite"
          className="h-[min(280px,40vh)]"
        >
          <div className="py-1">
            {filteredItems.length === 0 ? (
              <p className="px-3 py-4 text-sm text-muted-foreground text-center">
                No events yet. Activity and run updates will appear here.
              </p>
            ) : (
              filteredItems.map((item) => (
                <LiveFeedItemRow
                  key={`${item.event.type}-${item.event.id}-${item.event.createdAt}`}
                  item={item}
                  agentNameMap={agentNameMap}
                />
              ))
            )}
          </div>
        </ScrollArea>
      )}
    </aside>
  );
}
