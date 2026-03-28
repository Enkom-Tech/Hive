import { executeRunInvocation } from "./adapter-execution-invoke.js";
import type { AdapterExecutionDeps } from "./adapter-execution-types.js";

export { getDefaultSessionCodec, resolveNextSessionState, resolveWorkspaceForRun } from "./adapter-execution-prelude.js";

export type { AdapterExecutionDeps, ExecuteRunInvocationResult } from "./adapter-execution-types.js";

export function createAdapterExecution(deps: AdapterExecutionDeps) {
  return {
    executeRunInvocation: (runId: string) => executeRunInvocation(deps, runId),
  };
}
