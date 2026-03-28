export const NEW_ISSUE_DRAFT_KEY = "hive:issue-draft";
export const NEW_ISSUE_DRAFT_DEBOUNCE_MS = 800;

export interface NewIssueDraft {
  title: string;
  description: string;
  status: string;
  priority: string;
  assigneeId: string;
  projectId: string;
  departmentId: string;
  assigneeModelOverride: string;
  assigneeThinkingEffort: string;
  assigneeChrome: boolean;
  useIsolatedExecutionWorkspace: boolean;
}

/** Return black or white hex based on background luminance (WCAG perceptual weights). */
export function getContrastTextColor(hexColor: string): string {
  const hex = hexColor.replace("#", "");
  const r = parseInt(hex.substring(0, 2), 16);
  const g = parseInt(hex.substring(2, 4), 16);
  const b = parseInt(hex.substring(4, 6), 16);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.5 ? "#000000" : "#ffffff";
}

export function loadNewIssueDraft(): NewIssueDraft | null {
  try {
    const raw = localStorage.getItem(NEW_ISSUE_DRAFT_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as NewIssueDraft;
  } catch {
    return null;
  }
}

export function saveNewIssueDraft(draft: NewIssueDraft) {
  localStorage.setItem(NEW_ISSUE_DRAFT_KEY, JSON.stringify(draft));
}

export function clearNewIssueDraft() {
  localStorage.removeItem(NEW_ISSUE_DRAFT_KEY);
}
