package controllers

import "testing"

func TestTenantWorkspacePVCName_MatchesCompanyAndWorkerPool(t *testing.T) {
	companyID := "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
	want := "workspace-" + companyID
	if got := tenantWorkspacePVCName(companyID); got != want {
		t.Fatalf("tenantWorkspacePVCName: got %q, want %q", got, want)
	}
	// Invariant: must not use HiveCompany metadata.name (companyRef); workerpool uses company.Spec.CompanyID.
}
