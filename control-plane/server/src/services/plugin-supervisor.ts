import { logger } from "../middleware/logger.js";
import { subscribePluginDomainEvents } from "./plugin-domain-events.js";

/**
 * In-process supervisor stub: attaches to the plugin domain bridge.
 * Out-of-process workers (spawn + stdio/socket) can be added here without changing the bridge contract.
 */
export function startPluginSupervisorRuntime(): { stop: () => void } {
  const off = subscribePluginDomainEvents((_event) => {
    // Reserved for filtered fan-out to child processes and capability-gated RPC peers.
    if (process.env.HIVE_PLUGIN_SUPERVISOR_DEBUG === "1") {
      logger.debug({ pluginSupervisor: true }, "plugin domain event (no OOP worker attached)");
    }
  });
  return { stop: off };
}
