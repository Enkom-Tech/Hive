import type { Department, DepartmentMembership, PrincipalType } from "@hive/shared";
import { api } from "./client";

export const departmentsApi = {
  list: (companyId: string) => api.get<Department[]>(`/companies/${companyId}/departments`),
  create: (
    companyId: string,
    data: { name: string; slug: string; productionPolicies?: string | null },
  ) => api.post<Department>(`/companies/${companyId}/departments`, data),
  update: (
    companyId: string,
    departmentId: string,
    data: Partial<{ name: string; slug: string; status: string; productionPolicies?: string | null }>,
  ) => api.patch<Department>(`/companies/${companyId}/departments/${departmentId}`, data),
  remove: (companyId: string, departmentId: string) =>
    api.delete<{ ok: true }>(`/companies/${companyId}/departments/${departmentId}`),
  listMemberships: (
    companyId: string,
    departmentId: string,
    filters?: { principalType?: PrincipalType; principalId?: string },
  ) => {
    const params = new URLSearchParams();
    if (filters?.principalType) params.set("principalType", filters.principalType);
    if (filters?.principalId) params.set("principalId", filters.principalId);
    const qs = params.toString();
    return api.get<DepartmentMembership[]>(
      `/companies/${companyId}/departments/${departmentId}/memberships${qs ? `?${qs}` : ""}`,
    );
  },
  upsertMembership: (
    companyId: string,
    departmentId: string,
    data: { principalType: PrincipalType; principalId: string; isPrimary?: boolean; status?: string },
  ) => api.put<DepartmentMembership>(`/companies/${companyId}/departments/${departmentId}/memberships`, data),
  removeMembership: (companyId: string, departmentId: string, principalType: PrincipalType, principalId: string) => {
    const params = new URLSearchParams({ principalType, principalId });
    return api.delete<{ ok: true }>(
      `/companies/${companyId}/departments/${departmentId}/memberships?${params.toString()}`,
    );
  },
};
