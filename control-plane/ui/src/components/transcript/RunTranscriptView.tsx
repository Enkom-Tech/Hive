import { useMemo, useState } from "react";
import type { TranscriptEntry } from "../../adapters";
import { MarkdownBody } from "../MarkdownBody";
import { cn, formatTokens } from "../../lib/utils";
import {
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  TerminalSquare,
  User,
  Wrench,
} from "lucide-react";

export type { TranscriptMode, TranscriptDensity, TranscriptBlock } from "./run-transcript-types.js";
export { normalizeTranscript } from "./run-transcript-normalize.js";
import type { TranscriptBlock, TranscriptDensity, TranscriptMode } from "./run-transcript-types.js";
import {
  formatToolPayload,
  normalizeTranscript,
  parseStructuredToolResult,
  summarizeToolInput,
  summarizeToolResult,
  truncate,
} from "./run-transcript-normalize.js";

interface RunTranscriptViewProps {
  entries: TranscriptEntry[];
  mode?: TranscriptMode;
  density?: TranscriptDensity;
  limit?: number;
  streaming?: boolean;
  collapseStdout?: boolean;
  emptyMessage?: string;
  className?: string;
  thinkingClassName?: string;
}

function TranscriptMessageBlock({
  block,
  density,
}: {
  block: Extract<TranscriptBlock, { type: "message" }>;
  density: TranscriptDensity;
}) {
  const isAssistant = block.role === "assistant";
  const compact = density === "compact";

  return (
    <div>
      {!isAssistant && (
        <div className="mb-1.5 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
          <User className={compact ? "h-3.5 w-3.5" : "h-4 w-4"} />
          <span>User</span>
        </div>
      )}
      <MarkdownBody
        className={cn(
          "[&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
          compact ? "text-xs leading-5 text-foreground/85" : "text-sm",
        )}
      >
        {block.text}
      </MarkdownBody>
      {block.streaming && (
        <div className="mt-2 inline-flex items-center gap-1 text-[10px] font-medium italic text-muted-foreground">
          <span className="relative flex h-1.5 w-1.5">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-current opacity-70" />
            <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-current" />
          </span>
          Streaming
        </div>
      )}
    </div>
  );
}

function TranscriptThinkingBlock({
  block,
  density,
  className,
}: {
  block: Extract<TranscriptBlock, { type: "thinking" }>;
  density: TranscriptDensity;
  className?: string;
}) {
  return (
    <MarkdownBody
      className={cn(
        "italic text-foreground/70 [&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
        density === "compact" ? "text-[11px] leading-5" : "text-sm leading-6",
        className,
      )}
    >
      {block.text}
    </MarkdownBody>
  );
}

function TranscriptToolCard({
  block,
  density,
}: {
  block: Extract<TranscriptBlock, { type: "tool" }>;
  density: TranscriptDensity;
}) {
  const [open, setOpen] = useState(block.status === "error");
  const compact = density === "compact";
  const parsedResult = parseStructuredToolResult(block.result);
  const statusLabel =
    block.status === "running"
      ? "Running"
      : block.status === "error"
        ? "Errored"
        : "Completed";
  const statusTone =
    block.status === "running"
      ? "text-accent"
      : block.status === "error"
        ? "text-red-700 dark:text-red-300"
        : "text-emerald-700 dark:text-emerald-300";
  const detailsClass = cn(
    "space-y-3",
    block.status === "error" && "rounded-xl border border-red-500/20 bg-red-500/6 p-3",
  );
  const iconClass = cn(
    "mt-0.5 h-3.5 w-3.5 shrink-0",
    block.status === "error"
      ? "text-red-600 dark:text-red-300"
      : block.status === "completed"
        ? "text-emerald-600 dark:text-emerald-300"
        : "text-accent",
  );
  const summary = block.status === "running"
    ? summarizeToolInput(block.name, block.input, density)
    : block.status === "completed" && parsedResult?.body
      ? truncate(parsedResult.body.split("\n")[0] ?? parsedResult.body, compact ? 84 : 140)
      : summarizeToolResult(block.result, block.isError, density);

  return (
    <div className={cn(block.status === "error" && "rounded-xl border border-red-500/20 bg-red-500/4 p-3")}>
      <div className="flex items-start gap-2">
        {block.status === "error" ? (
          <CircleAlert className={iconClass} />
        ) : block.status === "completed" ? (
          <Check className={iconClass} />
        ) : (
          <Wrench className={iconClass} />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
              {block.name}
            </span>
            <span className={cn("text-[10px] font-semibold uppercase tracking-[0.14em]", statusTone)}>
              {statusLabel}
            </span>
          </div>
          <div className={cn("mt-1 wrap-break-word text-foreground/80", compact ? "text-xs" : "text-sm")}>
            {summary}
          </div>
        </div>
        <button
          type="button"
          className="mt-0.5 inline-flex h-5 w-5 items-center justify-center text-muted-foreground transition-colors hover:text-foreground"
          onClick={() => setOpen((value) => !value)}
          aria-label={open ? "Collapse tool details" : "Expand tool details"}
        >
          {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </button>
      </div>
      {open && (
        <div className="mt-3">
          <div className={detailsClass}>
            <div className={cn("grid gap-3", compact ? "grid-cols-1" : "lg:grid-cols-2")}>
              <div>
                <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                  Input
                </div>
                <pre className="overflow-x-auto whitespace-pre-wrap wrap-break-word font-mono text-[11px] text-foreground/80">
                  {formatToolPayload(block.input) || "<empty>"}
                </pre>
              </div>
              <div>
                <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                  Result
                </div>
                <pre className={cn(
                  "overflow-x-auto whitespace-pre-wrap wrap-break-word font-mono text-[11px]",
                  block.status === "error" ? "text-red-700 dark:text-red-300" : "text-foreground/80",
                )}>
                  {block.result ? formatToolPayload(block.result) : "Waiting for result..."}
                </pre>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function hasSelectedText() {
  if (typeof window === "undefined") return false;
  return (window.getSelection()?.toString().length ?? 0) > 0;
}

function TranscriptCommandGroup({
  block,
  density,
}: {
  block: Extract<TranscriptBlock, { type: "command_group" }>;
  density: TranscriptDensity;
}) {
  const [open, setOpen] = useState(false);
  const compact = density === "compact";
  const runningItem = [...block.items].reverse().find((item) => item.status === "running");
  const latestItem = block.items[block.items.length - 1] ?? null;
  const hasError = block.items.some((item) => item.status === "error");
  const isRunning = Boolean(runningItem);
  const showExpandedErrorState = open && hasError;
  const title = isRunning
    ? "Executing command"
    : block.items.length === 1
      ? "Executed command"
      : `Executed ${block.items.length} commands`;
  const subtitle = runningItem
    ? summarizeToolInput("command_execution", runningItem.input, density)
    : null;
  const statusTone = isRunning
      ? "text-accent"
      : "text-foreground/70";

  return (
    <div className={cn(showExpandedErrorState && "rounded-xl border border-red-500/20 bg-red-500/4 p-3")}>
      <div
        role="button"
        tabIndex={0}
        className={cn("flex cursor-pointer gap-2", subtitle ? "items-start" : "items-center")}
        onClick={() => {
          if (hasSelectedText()) return;
          setOpen((value) => !value);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            setOpen((value) => !value);
          }
        }}
      >
        <div className={cn("flex shrink-0 items-center", subtitle && "mt-0.5")}>
          {block.items.slice(0, Math.min(block.items.length, 3)).map((_, index) => (
            <span
              key={index}
              className={cn(
                "inline-flex h-6 w-6 items-center justify-center rounded-full border shadow-sm",
                index > 0 && "-ml-1.5",
                isRunning
                  ? "border-accent/25 bg-accent/8 text-accent"
                  : "border-border/70 bg-background text-foreground/55",
                isRunning && "animate-pulse",
              )}
            >
              <TerminalSquare className="h-3.5 w-3.5" />
            </span>
          ))}
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[11px] font-semibold uppercase leading-none tracking-widest text-muted-foreground/70">
            {title}
          </div>
          {subtitle && (
            <div className={cn("mt-1 wrap-break-word font-mono text-foreground/85", compact ? "text-xs" : "text-sm")}>
              {subtitle}
            </div>
          )}
          {!subtitle && latestItem?.status === "error" && open && (
            <div className={cn("mt-1", compact ? "text-xs" : "text-sm", statusTone)}>
              Command failed
            </div>
          )}
        </div>
        <button
          type="button"
          className={cn(
            "inline-flex h-5 w-5 items-center justify-center text-muted-foreground transition-colors hover:text-foreground",
            subtitle && "mt-0.5",
          )}
          onClick={(event) => {
            event.stopPropagation();
            setOpen((value) => !value);
          }}
          aria-label={open ? "Collapse command details" : "Expand command details"}
        >
          {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </button>
      </div>
      {open && (
        <div className={cn("mt-3 space-y-3", hasError && "rounded-xl border border-red-500/20 bg-red-500/6 p-3")}>
          {block.items.map((item, index) => (
            <div key={`${item.ts}-${index}`} className="space-y-2">
              <div className="flex items-center gap-2">
                <span className={cn(
                  "inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full border",
                  item.status === "error"
                    ? "border-red-500/25 bg-red-500/8 text-red-600 dark:text-red-300"
                    : item.status === "running"
                      ? "border-accent/25 bg-accent/8 text-accent"
                      : "border-border/70 bg-background text-foreground/55",
                )}>
                  <TerminalSquare className="h-3 w-3" />
                </span>
                <span className={cn("font-mono break-all", compact ? "text-[11px]" : "text-xs")}>
                  {summarizeToolInput("command_execution", item.input, density)}
                </span>
              </div>
              {item.result && (
                <pre className={cn(
                  "overflow-x-auto whitespace-pre-wrap wrap-break-word font-mono text-[11px]",
                  item.status === "error" ? "text-red-700 dark:text-red-300" : "text-foreground/80",
                )}>
                  {formatToolPayload(item.result)}
                </pre>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function TranscriptActivityRow({
  block,
  density,
}: {
  block: Extract<TranscriptBlock, { type: "activity" }>;
  density: TranscriptDensity;
}) {
  return (
    <div className="flex items-start gap-2">
      {block.status === "completed" ? (
        <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-300" />
      ) : (
        <span className="relative mt-1 flex h-2.5 w-2.5 shrink-0">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent opacity-70" />
          <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-accent" />
        </span>
      )}
      <div className={cn(
        "wrap-break-word text-foreground/80",
        density === "compact" ? "text-xs leading-5" : "text-sm leading-6",
      )}>
        {block.name}
      </div>
    </div>
  );
}

function TranscriptEventRow({
  block,
  density,
}: {
  block: Extract<TranscriptBlock, { type: "event" }>;
  density: TranscriptDensity;
}) {
  const compact = density === "compact";
  const toneClasses =
    block.tone === "error"
      ? "rounded-xl border border-red-500/20 bg-red-500/6 p-3 text-red-700 dark:text-red-300"
      : block.tone === "warn"
        ? "text-amber-700 dark:text-amber-300"
        : block.tone === "info"
          ? "text-sky-700 dark:text-sky-300"
          : "text-foreground/75";

  return (
    <div className={toneClasses}>
      <div className="flex items-start gap-2">
        {block.tone === "error" ? (
          <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        ) : block.tone === "warn" ? (
          <TerminalSquare className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        ) : (
          <span className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-current/50" />
        )}
        <div className="min-w-0 flex-1">
          {block.label === "result" && block.tone !== "error" ? (
            <div className={cn("whitespace-pre-wrap wrap-break-word text-sky-700 dark:text-sky-300", compact ? "text-[11px]" : "text-xs")}>
              {block.text}
            </div>
          ) : (
            <div className={cn("whitespace-pre-wrap wrap-break-word", compact ? "text-[11px]" : "text-xs")}>
              <span className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/70">
                {block.label}
              </span>
              {block.text ? <span className="ml-2">{block.text}</span> : null}
            </div>
          )}
          {block.detail && (
            <pre className="mt-2 overflow-x-auto whitespace-pre-wrap wrap-break-word font-mono text-[11px] text-foreground/75">
              {block.detail}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}

function TranscriptStdoutRow({
  block,
  density,
  collapseByDefault,
}: {
  block: Extract<TranscriptBlock, { type: "stdout" }>;
  density: TranscriptDensity;
  collapseByDefault: boolean;
}) {
  const [open, setOpen] = useState(!collapseByDefault);

  return (
    <div>
      <div className="flex items-center gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
          stdout
        </span>
        <button
          type="button"
          className="inline-flex h-5 w-5 items-center justify-center text-muted-foreground transition-colors hover:text-foreground"
          onClick={() => setOpen((value) => !value)}
          aria-label={open ? "Collapse stdout" : "Expand stdout"}
        >
          {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </button>
      </div>
      {open && (
        <pre className={cn(
          "mt-2 overflow-x-auto whitespace-pre-wrap wrap-break-word font-mono text-foreground/80",
          density === "compact" ? "text-[11px]" : "text-xs",
        )}>
          {block.text}
        </pre>
      )}
    </div>
  );
}

function RawTranscriptView({
  entries,
  density,
}: {
  entries: TranscriptEntry[];
  density: TranscriptDensity;
}) {
  const compact = density === "compact";
  return (
    <div className={cn("font-mono", compact ? "space-y-1 text-[11px]" : "space-y-1.5 text-xs")}>
      {entries.map((entry, idx) => (
        <div
          key={`${entry.kind}-${entry.ts}-${idx}`}
          className={cn(
            "grid gap-x-3",
            "grid-cols-[auto_1fr]",
          )}
        >
          <span className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
            {entry.kind}
          </span>
          <pre className="min-w-0 whitespace-pre-wrap wrap-break-word text-foreground/80">
            {entry.kind === "tool_call"
              ? `${entry.name}\n${formatToolPayload(entry.input)}`
              : entry.kind === "tool_result"
                ? formatToolPayload(entry.content)
                : entry.kind === "result"
                  ? `${entry.text}\n${formatTokens(entry.inputTokens)} / ${formatTokens(entry.outputTokens)} / $${entry.costUsd.toFixed(6)}`
                  : entry.kind === "init"
                    ? `model=${entry.model}${entry.sessionId ? ` session=${entry.sessionId}` : ""}`
                    : entry.text}
          </pre>
        </div>
      ))}
    </div>
  );
}

export function RunTranscriptView({
  entries,
  mode = "nice",
  density = "comfortable",
  limit,
  streaming = false,
  collapseStdout = false,
  emptyMessage = "No transcript yet.",
  className,
  thinkingClassName,
}: RunTranscriptViewProps) {
  const blocks = useMemo(() => normalizeTranscript(entries, streaming), [entries, streaming]);
  const visibleBlocks = limit ? blocks.slice(-limit) : blocks;
  const visibleEntries = limit ? entries.slice(-limit) : entries;

  if (entries.length === 0) {
    return (
      <div className={cn("rounded-2xl border border-dashed border-border/70 bg-background/40 p-4 text-sm text-muted-foreground", className)}>
        {emptyMessage}
      </div>
    );
  }

  if (mode === "raw") {
    return (
      <div className={className}>
        <RawTranscriptView entries={visibleEntries} density={density} />
      </div>
    );
  }

  return (
    <div className={cn("space-y-3", className)}>
      {visibleBlocks.map((block, index) => (
        <div
          key={`${block.type}-${block.ts}-${index}`}
          className={cn(index === visibleBlocks.length - 1 && streaming && "animate-in fade-in slide-in-from-bottom-1 duration-300")}
        >
          {block.type === "message" && <TranscriptMessageBlock block={block} density={density} />}
          {block.type === "thinking" && (
            <TranscriptThinkingBlock block={block} density={density} className={thinkingClassName} />
          )}
          {block.type === "tool" && <TranscriptToolCard block={block} density={density} />}
          {block.type === "command_group" && <TranscriptCommandGroup block={block} density={density} />}
          {block.type === "stdout" && (
            <TranscriptStdoutRow block={block} density={density} collapseByDefault={collapseStdout} />
          )}
          {block.type === "activity" && <TranscriptActivityRow block={block} density={density} />}
          {block.type === "event" && <TranscriptEventRow block={block} density={density} />}
        </div>
      ))}
    </div>
  );
}

