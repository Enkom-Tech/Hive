import type { CLIAdapterModule } from "@hive/adapter-utils";
import { managedWorkerCLIAdapter } from "./managed-worker/index.js";

const adaptersByType = new Map<string, CLIAdapterModule>([
  [managedWorkerCLIAdapter.type, managedWorkerCLIAdapter],
]);

export function getCLIAdapter(type: string): CLIAdapterModule {
  return adaptersByType.get(type) ?? managedWorkerCLIAdapter;
}
