import { unprocessable } from "../errors.js";
import type { ServerAdapterModule } from "./types.js";
import { managedWorkerAdapter } from "./managed-worker/index.js";

const adaptersByType = new Map<string, ServerAdapterModule>([
  [managedWorkerAdapter.type, managedWorkerAdapter],
]);

export function getServerAdapter(type: string): ServerAdapterModule {
  const adapter = adaptersByType.get(type);
  if (!adapter) {
    throw unprocessable("Only managed_worker adapter is supported");
  }
  return adapter;
}

export async function listAdapterModels(type: string): Promise<{ id: string; label: string }[]> {
  const adapter = adaptersByType.get(type);
  if (!adapter) return [];
  if (adapter.listModels) {
    const discovered = await adapter.listModels();
    if (discovered.length > 0) return discovered;
  }
  return adapter.models ?? [];
}

export function listServerAdapters(): ServerAdapterModule[] {
  return Array.from(adaptersByType.values());
}

export function findServerAdapter(type: string): ServerAdapterModule | null {
  return adaptersByType.get(type) ?? null;
}

export function getAllowedAdapterTypes(): string[] {
  return listServerAdapters().map((a) => a.type);
}

export function assertAdapterTypeAllowed(adapterType: string | null): void {
  if (!adapterType || typeof adapterType !== "string" || adapterType.trim() === "") {
    throw unprocessable("adapterType is required and must be a non-empty string");
  }
  if (!findServerAdapter(adapterType)) {
    throw unprocessable(
      `Unknown adapter type: ${adapterType}. Only managed_worker is supported.`,
    );
  }
}

export type ValidateAdapterConfigOptions = {
  companyId?: string;
  resolveAdapterConfigForRuntime?: (
    companyId: string,
    config: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>;
};

export async function validateAdapterConfig(
  adapterType: string,
  adapterConfig: Record<string, unknown>,
  options?: ValidateAdapterConfigOptions,
): Promise<void> {
  const adapter = findServerAdapter(adapterType);
  if (!adapter) {
    throw unprocessable(`Unknown adapter type: ${adapterType}. Only managed_worker is supported.`);
  }
  if (adapter.validateConfig) {
    try {
      await Promise.resolve(adapter.validateConfig(adapterConfig, options));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw unprocessable(message);
    }
  }
}
