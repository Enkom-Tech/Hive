import type { ServerAdapterModule } from "../types.js";
import { execute } from "./execute.js";
import { testEnvironment } from "./test.js";
import { validateManagedWorkerConfig } from "./validate.js";

export const managedWorkerAdapter: ServerAdapterModule = {
  type: "managed_worker",
  execute,
  testEnvironment,
  supportsLocalAgentJwt: false,
  models: [],
  validateConfig: validateManagedWorkerConfig,
  agentConfigurationDoc: `# Managed worker adapter

Adapter: managed_worker

The worker process connects to the control plane over WebSocket (GET /api/workers/link). Runs and cancels are sent over that connection; status and logs are received from the worker. No URL is required in adapter config; the worker uses HIVE_CONTROL_PLANE_URL (or HIVE_CONTROL_PLANE_WS_URL) to connect.

Optional:
- timeoutMs (number): optional timeout hint in milliseconds (default 15000, min 1000, max 300000).
`,
};
