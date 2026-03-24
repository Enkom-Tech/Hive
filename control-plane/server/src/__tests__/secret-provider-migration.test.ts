import { describe, expect, it } from "vitest";
import { secretProviderMigrationService } from "../services/secret-provider-migration.js";

function createDbStub(whereResults: unknown[]) {
  const queue = [...whereResults];
  const where = async () => (queue.shift() as unknown[]) ?? [];
  const orderBy = async () => (queue.shift() as unknown[]) ?? [];
  const from = () => ({ where, orderBy });
  const select = () => ({ from });
  return { select } as any;
}

describe("secretProviderMigrationService", () => {
  it("dry-run reports usage from adapterConfig env secret refs", async () => {
    const db = createDbStub([
      [
        {
          id: "s1",
          companyId: "c1",
          name: "OPENAI_API_KEY",
          provider: "local_encrypted",
          externalRef: null,
          latestVersion: 1,
        },
      ],
      [{ id: "a1", adapterConfig: { env: { OPENAI_API_KEY: { type: "secret_ref", secretId: "s1" } } } }],
      [],
      [],
      [],
      [{ version: 1 }],
    ]);
    const svc = secretProviderMigrationService(db);
    const result = await svc.dryRun({ companyId: "c1", targetProvider: "vault" });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.usage).toEqual([{ kind: "agent", id: "a1" }]);
    expect(result.items[0]?.plannedExternalRef).toContain("companies/c1/secrets/s1");
  });
});
