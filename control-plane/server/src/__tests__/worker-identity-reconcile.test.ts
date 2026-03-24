import { describe, expect, it, vi } from "vitest";
import { reconcileWorkerIdentitySlotsForCompany } from "../services/worker-identity-reconcile.js";

describe("reconcileWorkerIdentitySlotsForCompany", () => {
  it("is a no-op when automation is disabled", async () => {
    const db = {} as import("@hive/db").Db;
    const create = vi.fn();
    const r = await reconcileWorkerIdentitySlotsForCompany(db, "c1111111-1111-1111-1111-111111111111", {
      enabled: false,
      createAgentFromSlot: create,
    });
    expect(r.agentsCreated).toBe(0);
    expect(r.slotsProcessed).toBe(0);
    expect(create).not.toHaveBeenCalled();
  });
});
