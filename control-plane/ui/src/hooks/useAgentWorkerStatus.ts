import { useQuery } from "@tanstack/react-query";
import { agentsApi } from "../api/agents";
import { queryKeys } from "../lib/queryKeys";

export function useAgentWorkerStatus(
  agentId: string | null,
  companyId: string | null,
  opts: { enabled: boolean; pollWhileDisconnected?: boolean },
) {
  const { enabled, pollWhileDisconnected = true } = opts;
  return useQuery({
    queryKey: agentId ? queryKeys.agents.workerConnection(agentId) : ["agents", "worker-connection", "none"],
    queryFn: () => agentsApi.workerConnection(agentId!, companyId ?? undefined),
    enabled: Boolean(agentId && companyId && enabled),
    refetchInterval: (query) => {
      if (!pollWhileDisconnected) return false;
      const connected = query.state.data?.connected === true;
      return connected ? false : 4000;
    },
  });
}
