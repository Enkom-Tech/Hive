// Package e2e holds end-to-end tests that require a k3d cluster.
// Run from infra/e2e with: E2E_KIND=1 make -C e2e test
// TestMain runs all tests; when E2E_KIND is not set, individual tests skip.
package e2e

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"
)

const e2eReadyTimeout = 3 * time.Minute
const e2ePollInterval = 3 * time.Second

// waitForE2EReady blocks until operator is Running, tenant namespace and worker deployment exist with a ready pod, or timeout.
// On timeout, writes a short diagnostic to stderr (operator phase, tenant ns, deployment status).
func waitForE2EReady(ctx context.Context) error {
	deadline, ok := ctx.Deadline()
	if !ok {
		deadline = time.Now().Add(e2eReadyTimeout)
	}
	var lastOperatorPhase, lastReadyReplicas string
	for time.Now().Before(deadline) {
		// 1. Operator pod Running
		out, err := exec.CommandContext(ctx, "kubectl", "get", "pods", "-n", operatorNS, "-l", operatorLabel, "-o", "jsonpath={.items[0].status.phase}").CombinedOutput()
		lastOperatorPhase = strings.TrimSpace(string(out))
		if err != nil || lastOperatorPhase != "Running" {
			time.Sleep(e2ePollInterval)
			continue
		}
		// 2. Tenant namespace exists
		out, err = exec.CommandContext(ctx, "kubectl", "get", "namespace", tenantNS, "-o=name").CombinedOutput()
		if err != nil || len(out) == 0 {
			time.Sleep(e2ePollInterval)
			continue
		}
		// 3. Worker deployment has at least 1 ready replica
		out, err = exec.CommandContext(ctx, "kubectl", "get", "deployment", "test-pool", "-n", tenantNS, "-o", "jsonpath={.status.readyReplicas}").CombinedOutput()
		lastReadyReplicas = strings.TrimSpace(string(out))
		if err != nil {
			time.Sleep(e2ePollInterval)
			continue
		}
		var ready int
		if _, _ = fmt.Sscanf(lastReadyReplicas, "%d", &ready); ready >= 1 {
			return nil
		}
		time.Sleep(e2ePollInterval)
	}
	// Diagnostic when timeout: dump state so we can see why test-pool never became ready
	dumpE2EDiagnostics()
	msg := fmt.Sprintf("e2e: cluster not ready within %v (operator phase=%q, test-pool readyReplicas=%q). Check: kubectl get pods -n hive-system; kubectl get hivecluster,hivecompany,hiveworkerpool -n hive-system; kubectl get all -n %s\n", e2eReadyTimeout, lastOperatorPhase, lastReadyReplicas, tenantNS)
	os.Stderr.WriteString(msg)
	return fmt.Errorf("%s", strings.TrimSpace(msg))
}

func dumpE2EDiagnostics() {
	ctx := context.Background()
	commands := []struct {
		name string
		args []string
	}{
		{"pods (hive-system)", []string{"get", "pods", "-n", operatorNS, "-o", "wide"}},
		{"pods (tenant)", []string{"get", "pods", "-n", tenantNS, "-o", "wide"}},
		{"pvc (tenant)", []string{"get", "pvc", "-n", tenantNS}},
		{"deployment (tenant)", []string{"get", "deployment", "test-pool", "-n", tenantNS, "-o", "wide"}},
		{"events (tenant)", []string{"get", "events", "-n", tenantNS, "--sort-by", ".lastTimestamp", "--field-selector", "type!=Normal"}},
	}
	for _, c := range commands {
		os.Stderr.WriteString("\n--- " + c.name + " ---\n")
		out, err := exec.CommandContext(ctx, "kubectl", c.args...).CombinedOutput()
		if err != nil {
			os.Stderr.WriteString("error: " + err.Error() + "\n")
		}
		os.Stderr.Write(out)
	}
	// Describe test-pool deployment if it exists (often shows replica/condition reason)
	os.Stderr.WriteString("\n--- describe deployment test-pool ---\n")
	out, _ := exec.CommandContext(ctx, "kubectl", "describe", "deployment", "test-pool", "-n", tenantNS).CombinedOutput()
	os.Stderr.Write(out)
}

func TestMain(m *testing.M) {
	if os.Getenv("E2E_KIND") != "" {
		ctx, cancel := context.WithTimeout(context.Background(), e2eReadyTimeout)
		defer cancel()
		if err := waitForE2EReady(ctx); err != nil {
			// Log and exit so tests don't run against an unready cluster
			os.Stderr.WriteString("e2e: cluster not ready within " + e2eReadyTimeout.String() + "\n")
			os.Exit(1)
		}
	}
	code := m.Run()
	os.Exit(code)
}

// TestE2EClusterReachable verifies kubectl can talk to the cluster when E2E_KIND=1.
// Run this first via make; if it fails, k3d cluster or kubeconfig is missing.
func TestE2EClusterReachable(t *testing.T) {
	if os.Getenv("E2E_KIND") == "" {
		t.Skip("set E2E_KIND=1 to run e2e tests")
	}
	out, err := exec.Command("kubectl", "get", "namespace", "default", "-o=name").CombinedOutput()
	if err != nil {
		t.Fatalf("cluster not reachable (is k3d cluster up?): %v, %s", err, out)
	}
	if string(out) != "namespace/default\n" {
		t.Errorf("unexpected kubectl output: %s", out)
	}
}
