import type { UIAdapterModule } from "../types";
import { parseManagedWorkerStdoutLine } from "./parse-stdout";
import { ManagedWorkerConfigFields } from "./config-fields";
import { buildManagedWorkerConfig } from "./build-config";

export const managedWorkerUIAdapter: UIAdapterModule = {
  type: "managed_worker",
  label: "Managed worker",
  parseStdoutLine: parseManagedWorkerStdoutLine,
  ConfigFields: ManagedWorkerConfigFields,
  buildAdapterConfig: buildManagedWorkerConfig,
};
