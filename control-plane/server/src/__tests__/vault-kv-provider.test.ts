import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { vaultProvider } from "../secrets/vault-kv-provider.js";

describe("vaultProvider", () => {
  const envBackup = { ...process.env };
  const fetchMock = vi.fn();

  beforeEach(() => {
    process.env = { ...envBackup };
    process.env.HIVE_VAULT_ADDR = "https://vault.example.com";
    process.env.HIVE_VAULT_TOKEN = "test-token";
    process.env.HIVE_VAULT_KV_MOUNT = "hive";
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
  });

  afterEach(() => {
    process.env = { ...envBackup };
    vi.unstubAllGlobals();
  });

  it("creates a vault-backed secret version", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ data: { version: 3 } }), { status: 200 }),
    );
    const result = await vaultProvider.createVersion({
      value: "super-secret",
      externalRef: "companies/c1/secrets/s1",
    });
    expect(result.externalRef).toBe("companies/c1/secrets/s1");
    expect(result.material).toMatchObject({
      scheme: "vault_kv_v2",
      mount: "hive",
      path: "companies/c1/secrets/s1",
      version: 3,
    });
  });

  it("resolves a specific version", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ data: { data: { value: "plain" } } }), { status: 200 }),
    );
    const value = await vaultProvider.resolveVersion({
      externalRef: "companies/c1/secrets/s1",
      material: {
        scheme: "vault_kv_v2",
        mount: "hive",
        path: "companies/c1/secrets/s1",
        version: 4,
      },
    });
    expect(value).toBe("plain");
  });
});
