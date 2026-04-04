import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@hive/db";
import { assertCompanyPermission } from "../routes/authz.js";
import { LOCAL_BOARD_USER_ID } from "../board-claim.js";
import { accessService } from "../services/access.js";

describe("assertCompanyPermission with HIVE_RBAC_ENFORCE_FOR_LOCAL_BOARD", () => {
  const prevEnv = process.env.HIVE_RBAC_ENFORCE_FOR_LOCAL_BOARD;
  const db = {} as Db;
  const accessDouble = () => accessService(db);

  beforeEach(() => {
    process.env.HIVE_RBAC_ENFORCE_FOR_LOCAL_BOARD = "true";
    accessDouble().canUser.mockResolvedValue(false);
  });

  afterEach(() => {
    process.env.HIVE_RBAC_ENFORCE_FOR_LOCAL_BOARD = prevEnv;
    accessDouble().canUser.mockResolvedValue(true);
  });

  it("does not bypass RBAC for local-board user when env is set", async () => {
    const req = {
      principal: {
        type: "user" as const,
        id: LOCAL_BOARD_USER_ID,
        company_ids: ["c1"],
        roles: [] as string[],
      },
    } as unknown as import("fastify").FastifyRequest;

    await expect(assertCompanyPermission(db, req, "c1", "company:read")).rejects.toMatchObject({
      status: 403,
      message: "Permission denied",
    });
    expect(accessDouble().canUser).toHaveBeenCalledWith("c1", LOCAL_BOARD_USER_ID, "company:read");
  });
});
