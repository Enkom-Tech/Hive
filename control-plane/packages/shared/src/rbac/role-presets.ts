import type { PermissionKey } from "../constants.js";
import { COMPANY_MEMBERSHIP_ROLES } from "../constants.js";

export type CompanyMembershipRole = (typeof COMPANY_MEMBERSHIP_ROLES)[number];

export function isCompanyMembershipRole(value: string | null | undefined): value is CompanyMembershipRole {
  return value != null && (COMPANY_MEMBERSHIP_ROLES as readonly string[]).includes(value);
}

const VIEWER_KEYS = new Set<PermissionKey>(["company:read", "costs:read"]);

const OPERATOR_KEYS = new Set<PermissionKey>([
  "company:read",
  "costs:read",
  "issues:write",
  "goals:write",
  "projects:write",
  "agents:create",
  "tasks:assign",
  "tasks:assign_scope",
  "departments:assign_members",
  "activity:write",
  "approvals:act",
  "runs:board",
]);

/** All permission keys an admin may use (company-scoped). */
const ADMIN_KEY_LIST: PermissionKey[] = [
  ...Array.from(OPERATOR_KEYS),
  "users:invite",
  "users:manage_permissions",
  "departments:manage",
  "joins:approve",
  "company:settings",
  "secrets:manage",
  "costs:manage",
  "plugins:manage",
];

const ADMIN_KEYS = new Set<PermissionKey>(ADMIN_KEY_LIST);

/**
 * Base permissions implied by membership role (before explicit principal_permission_grants).
 * Explicit grants in the DB are OR'd in accessService.hasPermission.
 */
export function roleAllowsPermission(role: string | null | undefined, permissionKey: PermissionKey): boolean {
  if (!role || !isCompanyMembershipRole(role)) return false;
  if (role === "viewer") return VIEWER_KEYS.has(permissionKey);
  if (role === "operator") return OPERATOR_KEYS.has(permissionKey);
  if (role === "admin") return ADMIN_KEYS.has(permissionKey);
  return false;
}

/** Keys granted when applying a role preset to principal_permission_grants (optional sync). */
export function permissionKeysForRolePreset(role: CompanyMembershipRole): PermissionKey[] {
  if (role === "viewer") return [...VIEWER_KEYS];
  if (role === "operator") return [...OPERATOR_KEYS];
  return [...ADMIN_KEYS];
}
