import { and, eq, asc } from "drizzle-orm";
import type { Db } from "@hive/db";
import { departments, departmentMemberships } from "@hive/db";
import type { MembershipStatus, PrincipalType } from "@hive/shared";
import { conflict, notFound } from "../errors.js";

type DepartmentInsert = Omit<typeof departments.$inferInsert, "companyId">;

export function departmentService(db: Db) {
  async function getById(id: string) {
    return db
      .select()
      .from(departments)
      .where(eq(departments.id, id))
      .then((rows) => rows[0] ?? null);
  }

  async function requireCompanyDepartment(companyId: string, departmentId: string) {
    const row = await db
      .select()
      .from(departments)
      .where(and(eq(departments.id, departmentId), eq(departments.companyId, companyId)))
      .then((rows) => rows[0] ?? null);
    if (!row) throw notFound("Department not found");
    return row;
  }

  return {
    list: async (companyId: string) => {
      return db
        .select()
        .from(departments)
        .where(eq(departments.companyId, companyId))
        .orderBy(asc(departments.name), asc(departments.id));
    },

    getById,

    requireCompanyDepartment,

    create: async (companyId: string, data: DepartmentInsert) => {
      const [row] = await db
        .insert(departments)
        .values({
          companyId,
          ...data,
          updatedAt: new Date(),
        })
        .onConflictDoNothing()
        .returning();
      if (!row) {
        throw conflict("Department slug already exists in this company");
      }
      return row;
    },

    update: async (
      companyId: string,
      id: string,
      data: Partial<Pick<typeof departments.$inferInsert, "name" | "slug" | "status" | "productionPolicies">>,
    ) => {
      await requireCompanyDepartment(companyId, id);
      const [row] = await db
        .update(departments)
        .set({ ...data, updatedAt: new Date() })
        .where(and(eq(departments.id, id), eq(departments.companyId, companyId)))
        .returning();
      if (!row) throw notFound("Department not found");
      return row;
    },

    remove: async (companyId: string, id: string) => {
      await requireCompanyDepartment(companyId, id);
      await db.delete(departmentMemberships).where(eq(departmentMemberships.departmentId, id));
      const [row] = await db
        .delete(departments)
        .where(and(eq(departments.id, id), eq(departments.companyId, companyId)))
        .returning();
      return row;
    },

    listMemberships: async (companyId: string, departmentId: string) => {
      await requireCompanyDepartment(companyId, departmentId);
      return db
        .select()
        .from(departmentMemberships)
        .where(
          and(
            eq(departmentMemberships.companyId, companyId),
            eq(departmentMemberships.departmentId, departmentId),
          ),
        )
        .orderBy(
          asc(departmentMemberships.principalType),
          asc(departmentMemberships.principalId),
          asc(departmentMemberships.id),
        );
    },

    upsertMembership: async (input: {
      companyId: string;
      departmentId: string;
      principalType: PrincipalType;
      principalId: string;
      isPrimary?: boolean;
      status?: MembershipStatus;
    }) => {
      await requireCompanyDepartment(input.companyId, input.departmentId);
      const now = new Date();
      const [row] = await db
        .insert(departmentMemberships)
        .values({
          companyId: input.companyId,
          departmentId: input.departmentId,
          principalType: input.principalType,
          principalId: input.principalId,
          isPrimary: input.isPrimary ?? false,
          status: input.status ?? "active",
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [
            departmentMemberships.companyId,
            departmentMemberships.departmentId,
            departmentMemberships.principalType,
            departmentMemberships.principalId,
          ],
          set: {
            isPrimary: input.isPrimary ?? false,
            status: input.status ?? "active",
            updatedAt: now,
          },
        })
        .returning();
      return row;
    },

    removeMembership: async (input: {
      companyId: string;
      departmentId: string;
      principalType: PrincipalType;
      principalId: string;
    }) => {
      await requireCompanyDepartment(input.companyId, input.departmentId);
      const [row] = await db
        .delete(departmentMemberships)
        .where(
          and(
            eq(departmentMemberships.companyId, input.companyId),
            eq(departmentMemberships.departmentId, input.departmentId),
            eq(departmentMemberships.principalType, input.principalType),
            eq(departmentMemberships.principalId, input.principalId),
          ),
        )
        .returning();
      return row ?? null;
    },

    listPrincipalDepartmentIds: async (companyId: string, principalType: PrincipalType, principalId: string) => {
      const rows = await db
        .select({ departmentId: departmentMemberships.departmentId })
        .from(departmentMemberships)
        .where(
          and(
            eq(departmentMemberships.companyId, companyId),
            eq(departmentMemberships.principalType, principalType),
            eq(departmentMemberships.principalId, principalId),
            eq(departmentMemberships.status, "active"),
          ),
        );
      return rows.map((row) => row.departmentId);
    },
  };
}
