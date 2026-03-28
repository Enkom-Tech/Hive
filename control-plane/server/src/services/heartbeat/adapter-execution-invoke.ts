import type { AdapterExecutionDeps, ExecuteRunInvocationResult } from "./adapter-execution-types.js";
import { finalizeAdapterInvocationExecute } from "./adapter-execution-invoke-finalize.js";
import { prepareAdapterInvocationPhase } from "./adapter-execution-invoke-prepare.js";

export async function executeRunInvocation(
  deps: AdapterExecutionDeps,
  runId: string,
): Promise<ExecuteRunInvocationResult | null> {
  const { getRun, getAgent } = deps;

  const run = await getRun(runId);
  if (!run) return null;
  if (run.status !== "queued" && run.status !== "running") return null;

  const agent = await getAgent(run.agentId);
  if (!agent) return null;

  const prepared = await prepareAdapterInvocationPhase(deps, run, agent);
  return finalizeAdapterInvocationExecute(deps, runId, agent, prepared, run);
}
