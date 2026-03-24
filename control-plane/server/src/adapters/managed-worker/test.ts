import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "../types.js";
import { parseObject } from "../utils.js";
import { validateManagedWorkerConfig } from "./validate.js";

function summarizeStatus(checks: AdapterEnvironmentCheck[]): AdapterEnvironmentTestResult["status"] {
  if (checks.some((c) => c.level === "error")) return "fail";
  if (checks.some((c) => c.level === "warn")) return "warn";
  return "pass";
}

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const config = parseObject(ctx.config);

  try {
    validateManagedWorkerConfig(config as Record<string, unknown>);
    checks.push({
      code: "managed_worker_config_valid",
      level: "info",
      message: "Managed worker config is valid (worker connects to control plane via WebSocket).",
    });
  } catch (err) {
    checks.push({
      code: "managed_worker_config_invalid",
      level: "error",
      message: err instanceof Error ? err.message : "Invalid managed worker config",
    });
  }

  return {
    adapterType: ctx.adapterType,
    status: summarizeStatus(checks),
    checks,
    testedAt: new Date().toISOString(),
  };
}
