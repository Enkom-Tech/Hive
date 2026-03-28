export type AgentDetailView = "overview" | "configure" | "runs" | "attribution";

export function parseAgentDetailView(value: string | null): AgentDetailView {
  if (value === "configure" || value === "configuration") return "configure";
  if (value === "runs") return "runs";
  if (value === "attribution") return "attribution";
  return "overview";
}
