import { describe, expect, it, vi } from "vitest";
import { workerInstanceAgents, workerInstances } from "@hive/db";
import { applyWorkerHello } from "../workers/worker-hello.js";

describe("applyWorkerHello (ADR 005)", () => {
  it("never inserts into worker_instance_agents", async () => {
    const agentId = "a1111111-1111-1111-1111-111111111111";
    const companyId = "c2222222-2222-2222-2222-222222222222";
    const sid = "b3333333-3333-4333-8333-333333333333";
    const agentRow = {
      id: agentId,
      companyId,
      metadata: {},
    };

    let selectPhase = 0;
    const thenableRows = (rows: unknown[]) => ({
      then(onFulfilled: (r: unknown[]) => unknown) {
        return Promise.resolve(rows).then(onFulfilled);
      },
    });
    const tx = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => {
            selectPhase += 1;
            const rows =
              selectPhase === 1 ? [agentRow] : selectPhase === 2 ? [] : [];
            return thenableRows(rows);
          }),
        })),
      })),
      update: vi.fn(() => ({
        set: vi.fn(() => ({
          where: vi.fn(() => Promise.resolve(undefined)),
        })),
      })),
      insert: vi.fn((table: unknown) => {
        if (table === workerInstanceAgents) {
          return {
            values: vi.fn(() => ({
              returning: vi.fn(() => {
                throw new Error("ADR 005: hello must not write worker_instance_agents");
              }),
            })),
          };
        }
        if (table === workerInstances) {
          return {
            values: vi.fn(() => ({
              returning: vi.fn(() => Promise.resolve([{ id: "wi-new" }])),
            })),
          };
        }
        throw new Error("unexpected insert table");
      }),
    };

    const db = {
      transaction: async (fn: (t: typeof tx) => Promise<void>) => {
        await fn(tx);
      },
    };

    await applyWorkerHello(db as import("@hive/db").Db, agentId, companyId, {
      hostname: "h1",
      os: "linux",
      arch: "amd64",
      version: "1",
      instanceId: sid,
    });

    expect(tx.insert).toHaveBeenCalledWith(workerInstances);
    expect(tx.insert).not.toHaveBeenCalledWith(workerInstanceAgents);
  });
});
