import type { UIAdapterModule } from "./types";
import { managedWorkerUIAdapter } from "./managed-worker";

const adaptersByType = new Map<string, UIAdapterModule>([
  [managedWorkerUIAdapter.type, managedWorkerUIAdapter],
]);

export function getUIAdapter(type: string): UIAdapterModule {
  return adaptersByType.get(type) ?? managedWorkerUIAdapter;
}
