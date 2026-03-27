import type { Request } from "express";
import { describe, expect, it, vi } from "vitest";
import { resolvePrincipalBuiltin } from "../auth/resolvers/builtin.js";
import { isLocalImplicit } from "../auth/principal.js";
import { LOCAL_BOARD_USER_ID } from "../board-claim.js";

describe("resolvePrincipalBuiltin local_trusted", () => {
  it("returns user principal with company_ids from active memberships", async () => {
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => Promise.resolve([{ companyId: "550e8400-e29b-41d4-a716-446655440001" }])),
        })),
      })),
    } as unknown as import("@hive/db").Db;

    const req = { header: vi.fn(() => undefined) } as unknown as Request;
    const p = await resolvePrincipalBuiltin(req, {
      db,
      deploymentMode: "local_trusted",
    });
    expect(p?.type).toBe("user");
    expect(p?.id).toBe(LOCAL_BOARD_USER_ID);
    expect(p?.roles).toEqual(["instance_admin"]);
    expect(p?.company_ids).toEqual(["550e8400-e29b-41d4-a716-446655440001"]);
  });
});

describe("isLocalImplicit", () => {
  it("is true for local-board user principal", () => {
    const req = {
      principal: { type: "user" as const, id: LOCAL_BOARD_USER_ID, roles: ["instance_admin"] },
    } as Request;
    expect(isLocalImplicit(req)).toBe(true);
  });

  it("is true for legacy system principal", () => {
    const req = {
      principal: { type: "system" as const, id: "local-board", roles: ["instance_admin"] },
    } as Request;
    expect(isLocalImplicit(req)).toBe(true);
  });
});
