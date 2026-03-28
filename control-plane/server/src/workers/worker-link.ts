export { trySendJsonToWorkerInstance } from "./worker-link-registry.js";

export type { LinkAuth, HeartbeatWorkerLink, MintInstanceLinkToken, WorkerLinkAttachOpts } from "./worker-link-types.js";

export { attachWorkerLinkUpgrade } from "./worker-link-upgrade.js";
export {
  sendRunToWorker,
  sendCancelToWorker,
  sendDeployGrantToWorker,
  isAgentWorkerConnected,
  getWorkerLinkStableInstanceId,
  getConnectedManagedWorkerAgentIdsForCompany,
  isWorkerInstanceConnected,
} from "./worker-link-send.js";
