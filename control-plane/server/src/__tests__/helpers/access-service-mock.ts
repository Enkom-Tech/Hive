import { vi } from "vitest";

/**
 * Patches {@link accessService} for route tests that use an empty `Db` stub.
 * Obtain the singleton double via `accessService({} as Db)` from `../services/access.js` after this setup runs.
 */
vi.mock("../../services/access.js", () => {
  const impl = {
    isInstanceAdmin: vi.fn(async () => false),
    canUser: vi.fn(async () => true),
    hasPermission: vi.fn(async () => true),
    canPrincipalAssignAgent: vi.fn(async () => true),
    listPrincipalDepartmentIds: vi.fn(async () => [] as string[]),
    isPrincipalInDepartment: vi.fn(async () => false),
    canAssignPrincipalToIssueDepartment: vi.fn(async () => true),
    getMembership: vi.fn(async () => null),
    ensureMembership: vi.fn(async () => ({})),
    listMembers: vi.fn(async () => []),
    setMemberPermissions: vi.fn(async () => null),
    promoteInstanceAdmin: vi.fn(),
    promoteFirstInstanceAdminIfVacant: vi.fn(async () => undefined),
    demoteInstanceAdmin: vi.fn(),
    listUserCompanyAccess: vi.fn(async () => []),
    setUserCompanyAccess: vi.fn(async () => []),
    setPrincipalGrants: vi.fn(async () => undefined),
  };
  return {
    accessService: (_db: unknown) => impl,
  };
});
