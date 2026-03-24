import { pgTable, uuid, text, boolean, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { departments } from "./departments.js";

export const departmentMemberships = pgTable(
  "department_memberships",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    departmentId: uuid("department_id").notNull().references(() => departments.id),
    principalType: text("principal_type").notNull(),
    principalId: text("principal_id").notNull(),
    isPrimary: boolean("is_primary").notNull().default(false),
    status: text("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    uniqueMembershipIdx: uniqueIndex("department_memberships_unique_idx").on(
      table.companyId,
      table.departmentId,
      table.principalType,
      table.principalId,
    ),
    principalStatusIdx: index("department_memberships_principal_status_idx").on(
      table.companyId,
      table.principalType,
      table.principalId,
      table.status,
    ),
    departmentStatusIdx: index("department_memberships_department_status_idx").on(
      table.companyId,
      table.departmentId,
      table.status,
    ),
    primaryPrincipalIdx: index("department_memberships_primary_principal_idx").on(
      table.companyId,
      table.principalType,
      table.principalId,
      table.isPrimary,
    ),
  }),
);
