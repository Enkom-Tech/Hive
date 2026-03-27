import { vi } from "vitest";

/** Use real access service + DB; server unit tests mock `../services/access.js` globally. */
vi.unmock("../services/access.js");

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { applyPendingMigrations, instanceUserRoles } from "@hive/db";
import type { Db } from "@hive/db";
import postgres from "postgres";
import * as schema from "../../../packages/db/src/schema/index.js";
import { accessService } from "../services/access.js";

/**
 * Exercises promoteFirstInstanceAdminIfVacant against a real Postgres.
 * Set `HIVE_ACCESS_FIRST_ADMIN_TEST_URL` (e.g. postgres://user:pass@127.0.0.1:5432/hive_test).
 * Skipped in CI unless this env is provided (same pattern as worker Redis integration tests).
 */
const testUrl = process.env.HIVE_ACCESS_FIRST_ADMIN_TEST_URL?.trim();

describe.skipIf(!testUrl)("accessService promoteFirstInstanceAdminIfVacant (integration)", () => {
  let sqlClient: postgres.Sql;
  let db: Db;

  beforeAll(async () => {
    await applyPendingMigrations(testUrl!);
    sqlClient = postgres(testUrl!, { max: 2, onnotice: () => {} });
    db = drizzle(sqlClient, { schema }) as Db;
  });

  afterAll(async () => {
    await sqlClient.end({ timeout: 5 });
  });

  beforeEach(async () => {
    await db.execute(sql`delete from instance_user_roles`);
  });

  it("promotes the user when no instance_admin exists", async () => {
    const access = accessService(db);
    await access.promoteFirstInstanceAdminIfVacant("first-user-id");
    expect(await access.isInstanceAdmin("first-user-id")).toBe(true);
    const rows = await db.select().from(instanceUserRoles);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.userId).toBe("first-user-id");
    expect(rows[0]?.role).toBe("instance_admin");
  });

  it("does nothing for a second user when an instance_admin already exists", async () => {
    const access = accessService(db);
    await access.promoteFirstInstanceAdminIfVacant("user-a");
    await access.promoteFirstInstanceAdminIfVacant("user-b");
    expect(await access.isInstanceAdmin("user-a")).toBe(true);
    expect(await access.isInstanceAdmin("user-b")).toBe(false);
    const rows = await db.select().from(instanceUserRoles);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.userId).toBe("user-a");
  });

  it("is idempotent for the same user", async () => {
    const access = accessService(db);
    await access.promoteFirstInstanceAdminIfVacant("same-user");
    await access.promoteFirstInstanceAdminIfVacant("same-user");
    const rows = await db.select().from(instanceUserRoles);
    expect(rows).toHaveLength(1);
  });

  it("does not add a duplicate row if promoteInstanceAdmin already ran", async () => {
    const access = accessService(db);
    await access.promoteInstanceAdmin("already-admin");
    await access.promoteFirstInstanceAdminIfVacant("already-admin");
    const rows = await db
      .select()
      .from(instanceUserRoles)
      .where(eq(instanceUserRoles.userId, "already-admin"));
    expect(rows).toHaveLength(1);
  });

  it("still promotes a real user when only local_trusted synthetic local-board is admin", async () => {
    const access = accessService(db);
    await db.insert(instanceUserRoles).values({
      userId: "local-board",
      role: "instance_admin",
    });
    await access.promoteFirstInstanceAdminIfVacant("human-after-local-trusted");
    expect(await access.isInstanceAdmin("human-after-local-trusted")).toBe(true);
    const rows = await db.select().from(instanceUserRoles);
    expect(rows).toHaveLength(2);
  });
});
