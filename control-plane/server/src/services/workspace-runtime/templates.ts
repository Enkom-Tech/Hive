import { renderTemplate } from "../../adapters/utils.js";
import type { ExecutionWorkspaceAgentRef, ExecutionWorkspaceIssueRef } from "./types.js";

function sanitizeSlugPart(value: string | null | undefined, fallback: string): string {
  const raw = (value ?? "").trim().toLowerCase();
  const normalized = raw
    .replace(/[^a-z0-9/_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-/]+|[-/]+$/g, "");
  return normalized.length > 0 ? normalized : fallback;
}

export function renderWorkspaceTemplate(
  template: string,
  input: {
    issue: ExecutionWorkspaceIssueRef | null;
    agent: ExecutionWorkspaceAgentRef;
    projectId: string | null;
    repoRef: string | null;
  },
) {
  const issueIdentifier = input.issue?.identifier ?? input.issue?.id ?? "issue";
  const slug = sanitizeSlugPart(input.issue?.title, sanitizeSlugPart(issueIdentifier, "issue"));
  return renderTemplate(template, {
    issue: {
      id: input.issue?.id ?? "",
      identifier: input.issue?.identifier ?? "",
      title: input.issue?.title ?? "",
    },
    agent: {
      id: input.agent.id,
      name: input.agent.name,
    },
    project: {
      id: input.projectId ?? "",
    },
    workspace: {
      repoRef: input.repoRef ?? "",
    },
    slug,
  });
}
