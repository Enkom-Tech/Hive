import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { departmentsApi } from "../api/departments";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { Button } from "@/components/ui/button";
import { Building2 } from "lucide-react";

function toSlug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function DepartmentPoliciesRow({
  companyId,
  departmentId,
  name,
  slug,
  savedPolicies,
}: {
  companyId: string;
  departmentId: string;
  name: string;
  slug: string;
  savedPolicies: string | null;
}) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState(savedPolicies ?? "");
  const dirty = draft !== (savedPolicies ?? "");

  useEffect(() => {
    setDraft(savedPolicies ?? "");
  }, [savedPolicies, departmentId]);

  const savePolicies = useMutation({
    mutationFn: () =>
      departmentsApi.update(companyId, departmentId, {
        productionPolicies: draft.trim() || null,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.departments.list(companyId) });
    },
  });

  return (
    <details className="group border-b border-border last:border-b-0">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-2 text-sm marker:content-['']">
        <span className="font-medium">{name}</span>
        <span className="text-muted-foreground">{slug}</span>
      </summary>
      <div className="space-y-2 border-t border-border bg-muted/20 px-3 py-3">
        <label className="text-xs font-medium text-muted-foreground" htmlFor={`dept-policies-${departmentId}`}>
          Production policies (optional)
        </label>
        <textarea
          id={`dept-policies-${departmentId}`}
          className="w-full min-h-[100px] rounded-md border border-border bg-background px-2.5 py-2 text-sm outline-none"
          placeholder="Department-wide rules for production agents…"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            disabled={!dirty || savePolicies.isPending}
            onClick={() => savePolicies.mutate()}
          >
            {savePolicies.isPending ? "Saving…" : "Save policies"}
          </Button>
          {savePolicies.isError && (
            <span className="text-xs text-destructive">
              {savePolicies.error instanceof Error ? savePolicies.error.message : "Failed to save"}
            </span>
          )}
        </div>
      </div>
    </details>
  );
}

export function Departments() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const [name, setName] = useState("");

  useEffect(() => {
    setBreadcrumbs([{ label: "Departments" }]);
  }, [setBreadcrumbs]);

  const { data, isLoading, error } = useQuery({
    queryKey: queryKeys.departments.list(selectedCompanyId!),
    queryFn: () => departmentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const createDepartment = useMutation({
    mutationFn: (payload: { name: string; slug: string }) =>
      departmentsApi.create(selectedCompanyId!, payload),
    onSuccess: () => {
      setName("");
      queryClient.invalidateQueries({ queryKey: queryKeys.departments.list(selectedCompanyId!) });
    },
  });

  const canCreate = useMemo(() => name.trim().length > 0, [name]);

  if (!selectedCompanyId) {
    return <EmptyState icon={Building2} message="Select a company to view departments." />;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <input
          className="h-9 rounded-md border border-input bg-background px-3 text-sm"
          placeholder="Department name"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <Button
          disabled={!canCreate || createDepartment.isPending}
          onClick={() => createDepartment.mutate({ name: name.trim(), slug: toSlug(name) })}
        >
          Add Department
        </Button>
      </div>

      {error && <p className="text-sm text-destructive">{(error as Error).message}</p>}

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading departments...</p>
      ) : data && data.length > 0 ? (
        <div className="rounded-md border border-border overflow-hidden">
          {data.map((department) => (
            <DepartmentPoliciesRow
              key={department.id}
              companyId={selectedCompanyId}
              departmentId={department.id}
              name={department.name}
              slug={department.slug}
              savedPolicies={department.productionPolicies}
            />
          ))}
        </div>
      ) : (
        <EmptyState icon={Building2} message="No departments yet." />
      )}
    </div>
  );
}
