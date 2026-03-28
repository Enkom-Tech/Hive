import type { ActivityEvent, Agent } from "@hive/shared";
import { Identity } from "../Identity";

export function IssueDetailActorIdentity({
  evt,
  agentMap,
}: {
  evt: ActivityEvent;
  agentMap: Map<string, Agent>;
}) {
  const id = evt.actorId;
  if (evt.actorType === "agent") {
    const agent = agentMap.get(id);
    return <Identity name={agent?.name ?? id.slice(0, 8)} size="sm" />;
  }
  if (evt.actorType === "system") return <Identity name="System" size="sm" />;
  if (evt.actorType === "user") return <Identity name="Board" size="sm" />;
  return <Identity name={id || "Unknown"} size="sm" />;
}
