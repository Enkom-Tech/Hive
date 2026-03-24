import { createAgentSchema, updateAgentSchema } from "@hive/shared/validators/agent";
import { describe, expect, it } from "vitest";
import {
  assertAdapterTypeAllowed,
  findServerAdapter,
  getServerAdapter,
  getAllowedAdapterTypes,
  validateAdapterConfig,
} from "../adapters/registry.js";

describe("adapter registry", () => {
  it("getAllowedAdapterTypes returns only managed_worker", () => {
    const types = getAllowedAdapterTypes();
    expect(types).toEqual(["managed_worker"]);
  });

  it("findServerAdapter returns adapter for managed_worker", () => {
    expect(findServerAdapter("managed_worker")).not.toBeNull();
    expect(findServerAdapter("managed_worker")?.type).toBe("managed_worker");
  });

  it("findServerAdapter returns null for unknown type", () => {
    expect(findServerAdapter("unknown_adapter_xyz")).toBeNull();
  });

  it("getServerAdapter returns adapter for managed_worker", () => {
    const adapter = getServerAdapter("managed_worker");
    expect(adapter.type).toBe("managed_worker");
  });

  it("getServerAdapter throws for unknown type", () => {
    expect(() => getServerAdapter("process")).toThrow(/Only managed_worker adapter is supported/);
    expect(() => getServerAdapter("unknown_adapter_xyz")).toThrow(/Only managed_worker adapter is supported/);
  });

  it("assertAdapterTypeAllowed throws for null/empty/unknown type", () => {
    expect(() => assertAdapterTypeAllowed(null)).toThrow(/adapterType is required/);
    expect(() => assertAdapterTypeAllowed("")).toThrow(/adapterType is required/);
    expect(() => assertAdapterTypeAllowed("   ")).toThrow(/adapterType is required/);
    expect(() => assertAdapterTypeAllowed("unknown_adapter_xyz")).toThrow(/Unknown adapter type/);
  });

  it("assertAdapterTypeAllowed does not throw for managed_worker", () => {
    expect(() => assertAdapterTypeAllowed("managed_worker")).not.toThrow();
  });

  it("validateAdapterConfig throws for unknown adapter type", async () => {
    await expect(
      validateAdapterConfig("unknown_adapter_xyz", {}),
    ).rejects.toThrow(/Only managed_worker is supported/);
  });

  it("validateAdapterConfig resolves for managed_worker with valid config", async () => {
    await expect(validateAdapterConfig("managed_worker", {})).resolves.toBeUndefined();
    await expect(
      validateAdapterConfig("managed_worker", { timeoutMs: 15000 }),
    ).resolves.toBeUndefined();
  });
});

describe("shared agent validators (adapterType string)", () => {
  it("createAgentSchema defaults adapterType to managed_worker", () => {
    const out = createAgentSchema.parse({ name: "Test" });
    expect(out.adapterType).toBe("managed_worker");
  });

  it("createAgentSchema accepts managed_worker", () => {
    const out = createAgentSchema.parse({ name: "Test", adapterType: "managed_worker" });
    expect(out.adapterType).toBe("managed_worker");
  });

  it("updateAgentSchema accepts optional adapterType as non-empty string", () => {
    const out = updateAgentSchema.parse({ adapterType: "managed_worker" });
    expect(out.adapterType).toBe("managed_worker");
  });
});
