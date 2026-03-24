import type { CLIAdapterModule } from "@hive/adapter-utils";

function formatManagedWorkerStdoutEvent(raw: string, _debug: boolean): void {
  const line = raw.trim();
  if (line) console.log(line);
}

export const managedWorkerCLIAdapter: CLIAdapterModule = {
  type: "managed_worker",
  formatStdoutEvent: formatManagedWorkerStdoutEvent,
};
