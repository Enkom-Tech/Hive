import { describe, expect, it } from "vitest";
import type { Db } from "@hive/db";
import { authorizeCompanyEventsAccess } from "../realtime/company-events-auth.js";

const companyA = "550e8400-e29b-41d4-a716-446655440000";
const companyB = "650e8400-e29b-41d4-a716-446655440001";

/**
 * Same authorization path as live-events WebSocket upgrade (company in URL vs token/session).
 * Agent API key is scoped to one company; URL company must match.
 */
describe("authorizeCompanyEventsAccess — cross-tenant (WS/SSE)", () => {
  it("returns null when agent token belongs to another company than the URL company", async () => {
    const chain = {
      then<TResult1>(
        onfulfilled: (value: { companyId: string; agentId: string; id: string }[]) => TResult1 | PromiseLike<TResult1>,
      ): Promise<TResult1> {
        return Promise.resolve(
          onfulfilled([{ companyId: companyA, agentId: "agent-1", id: "key-1" }]),
        );
      },
    };
    const mockDb = {
      select: () => ({ from: () => ({ where: () => chain }) }),
      update: () => ({ set: () => ({ where: () => Promise.resolve() }) }),
    } as unknown as Db;

    const ctx = await authorizeCompanyEventsAccess(mockDb, companyB, {
      deploymentMode: "authenticated",
      token: "opaque-agent-token",
      sessionUserId: null,
    });

    expect(ctx).toBeNull();
  });
});
