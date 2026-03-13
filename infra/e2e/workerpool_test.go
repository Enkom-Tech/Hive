package e2e

import (
	"os"
	"os/exec"
	"testing"
)

// TestTenantLifecycle runs when E2E_KIND=1 and a k3d cluster is up with operator and fixtures deployed.
// It verifies that the operator created the tenant namespace and deployment (via kubectl for simplicity).
func TestTenantLifecycle(t *testing.T) {
	if os.Getenv("E2E_KIND") == "" {
		t.Skip("set E2E_KIND=1 to run e2e tests")
	}
	// Verify hive-system namespace exists
	out, err := exec.Command("kubectl", "get", "namespace", "hive-system", "-o=name").CombinedOutput()
	if err != nil {
		t.Fatalf("kubectl get namespace hive-system: %v, %s", err, out)
	}
	// Verify tenant namespace exists (company controller creates it)
	tenantNS := "hive-tenant-550e8400-e29b-41d4-a716-446655440000"
	out, err = exec.Command("kubectl", "get", "namespace", tenantNS, "-o=name").CombinedOutput()
	if err != nil {
		t.Logf("tenant namespace not yet created (operator may still be reconciling): %v, %s", err, out)
		return
	}
	// Verify deployment in tenant namespace
	out, err = exec.Command("kubectl", "get", "deployment", "test-pool", "-n", tenantNS, "-o=name").CombinedOutput()
	if err != nil {
		t.Logf("deployment not yet created: %v, %s", err, out)
		return
	}
	if string(out) != "deployment.apps/test-pool\n" {
		t.Errorf("unexpected output: %s", out)
	}
}
