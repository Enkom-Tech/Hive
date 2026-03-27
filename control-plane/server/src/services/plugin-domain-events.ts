import { EventEmitter } from "node:events";
import type { LiveEvent } from "@hive/shared";

const bridge = new EventEmitter();
bridge.setMaxListeners(0);

/** Fan-out hook after SSE/live events; OOP supervisors subscribe for filtered delivery. */
export function forwardLiveEventToPluginBridge(event: LiveEvent): void {
  bridge.emit("live", event);
}

export function subscribePluginDomainEvents(handler: (event: LiveEvent) => void): () => void {
  bridge.on("live", handler);
  return () => bridge.off("live", handler);
}
