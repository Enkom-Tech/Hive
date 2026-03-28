import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Minus,
  type LucideIcon,
} from "lucide-react";
import { issueStatusText, issueStatusTextDefault, priorityColor, priorityColorDefault } from "../../lib/status-colors";
import { ISSUE_STATUS_ORDER, ISSUE_STATUS_LABELS } from "@hive/shared";

// Deferred: per-issue worktrees — see doc/plugins/ and product roadmap; re-enable when workflow ships.
export const SHOW_EXPERIMENTAL_ISSUE_WORKTREE_UI = true;

export const newIssueDialogStatuses = ISSUE_STATUS_ORDER.map((value) => ({
  value,
  label: ISSUE_STATUS_LABELS[value],
  color: issueStatusText[value] ?? issueStatusTextDefault,
}));

export const newIssueDialogRequiresQualityReviewOptions = [
  { value: "default", label: "Company default", payload: null as boolean | null },
  { value: "yes", label: "Yes", payload: true },
  { value: "no", label: "No", payload: false },
] as const;

export type RequiresQualityReviewOptionValue = (typeof newIssueDialogRequiresQualityReviewOptions)[number]["value"];

export const newIssueDialogPriorities: Array<{
  value: string;
  label: string;
  icon: LucideIcon;
  color: string;
}> = [
  { value: "critical", label: "Critical", icon: AlertTriangle, color: priorityColor.critical ?? priorityColorDefault },
  { value: "high", label: "High", icon: ArrowUp, color: priorityColor.high ?? priorityColorDefault },
  { value: "medium", label: "Medium", icon: Minus, color: priorityColor.medium ?? priorityColorDefault },
  { value: "low", label: "Low", icon: ArrowDown, color: priorityColor.low ?? priorityColorDefault },
];
