import type { agents } from "@hive/db";
import { parseObject, asBoolean, asNumber } from "../../adapters/utils.js";
import { normalizeMaxConcurrentRuns } from "./types.js";

export function parseHeartbeatPolicy(agent: typeof agents.$inferSelect) {
  const runtimeConfig = parseObject(agent.runtimeConfig);
  const heartbeat = parseObject(runtimeConfig.heartbeat);
  return {
    enabled: asBoolean(heartbeat.enabled, true),
    intervalSec: Math.max(0, asNumber(heartbeat.intervalSec, 0)),
    wakeOnDemand: asBoolean(
      heartbeat.wakeOnDemand ?? heartbeat.wakeOnAssignment ?? heartbeat.wakeOnOnDemand ?? heartbeat.wakeOnAutomation,
      true,
    ),
    maxConcurrentRuns: normalizeMaxConcurrentRuns(heartbeat.maxConcurrentRuns),
  };
}
