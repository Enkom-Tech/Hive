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

const (
	tenantNS       = "hive-tenant-550e8400-e29b-41d4-a716-446655440000"
	operatorNS     = "hive-system"
	operatorLabel  = "app=hive-operator"
	workerLabel    = "app=test-pool"
	mockNS         = "default"
	mockDeployment = "mock-controlplane"
	pollInterval   = 2 * time.Second
	operatorWait   = 60 * time.Second
	evictionWait   = 90 * time.Second
	degradedWait   = 90 * time.Second // cluster controller requeues every 60s when healthy
)

// TestOperatorRestart deletes the operator pod and verifies K8s restarts it and reconciliation continues.
func TestOperatorRestart(t *testing.T) {
	if os.Getenv("E2E_KIND") == "" {
		t.Skip("set E2E_KIND=1 to run e2e tests")
	}
	ctx := context.Background()

	// Get one operator pod name
	out, err := exec.CommandContext(ctx, "kubectl", "get", "pods", "-n", operatorNS, "-l", operatorLabel, "-o", "jsonpath={.items[0].metadata.name}").CombinedOutput()
	if err != nil {
		t.Fatalf("kubectl get operator pods: %v, %s", err, out)
	}
	podName := strings.TrimSpace(string(out))
	if podName == "" {
		t.Fatal("no operator pod found")
	}

	// Delete the pod
	_, err = exec.CommandContext(ctx, "kubectl", "delete", "pod", podName, "-n", operatorNS, "--grace-period=0", "--force").CombinedOutput()
	if err != nil {
		t.Fatalf("kubectl delete operator pod: %v", err)
	}

	// Poll until a new pod is Running
	deadline := time.Now().Add(operatorWait)
	for time.Now().Before(deadline) {
		out, err = exec.CommandContext(ctx, "kubectl", "get", "pods", "-n", operatorNS, "-l", operatorLabel, "-o", "jsonpath={.items[0].status.phase}").CombinedOutput()
		if err == nil && string(out) == "Running" {
			break
		}
		time.Sleep(pollInterval)
	}
	if time.Now().After(deadline) {
		t.Fatalf("operator pod did not become Running within %v; last output: %s", operatorWait, out)
	}
}

// TestWorkerPodEviction deletes one worker pod and verifies the Deployment recreates it.
func TestWorkerPodEviction(t *testing.T) {
	if os.Getenv("E2E_KIND") == "" {
		t.Skip("set E2E_KIND=1 to run e2e tests")
	}
	ctx := context.Background()

	// Get one worker pod name (waitForE2EReady in TestMain should have ensured at least one exists)
	out, err := exec.CommandContext(ctx, "kubectl", "get", "pods", "-n", tenantNS, "-l", workerLabel, "-o", "jsonpath={.items[0].metadata.name}").CombinedOutput()
	podName := strings.TrimSpace(string(out))
	if err != nil || podName == "" {
		t.Skipf("no worker pod found (tenant or pool may not be ready): %v, %s", err, out)
	}

	// Delete the pod
	_, err = exec.CommandContext(ctx, "kubectl", "delete", "pod", podName, "-n", tenantNS, "--grace-period=0", "--force").CombinedOutput()
	if err != nil {
		t.Fatalf("kubectl delete worker pod: %v", err)
	}

	// Poll until deployment has desired == ready
	deadline := time.Now().Add(evictionWait)
	for time.Now().Before(deadline) {
		out, err = exec.CommandContext(ctx, "kubectl", "get", "deployment", "test-pool", "-n", tenantNS, "-o", "jsonpath={.status.readyReplicas}/{.spec.replicas}").CombinedOutput()
		if err != nil {
			time.Sleep(pollInterval)
			continue
		}
		var ready, desired int
		if _, _ = fmt.Sscanf(string(out), "%d/%d", &ready, &desired); ready == desired && desired > 0 {
			break
		}
		time.Sleep(pollInterval)
	}
	if time.Now().After(deadline) {
		t.Fatalf("deployment test-pool did not restore ready replicas within %v; last output: %s", evictionWait, out)
	}
}

// TestMockDisconnected scales the mock control plane to 0 and verifies the operator enters degraded state (Connected=false), then restores the mock.
func TestMockDisconnected(t *testing.T) {
	if os.Getenv("E2E_KIND") == "" {
		t.Skip("set E2E_KIND=1 to run e2e tests")
	}
	ctx := context.Background()

	// Scale mock to 0
	_, err := exec.CommandContext(ctx, "kubectl", "scale", "deployment", mockDeployment, "-n", mockNS, "--replicas=0").CombinedOutput()
	if err != nil {
		t.Fatalf("kubectl scale mock to 0: %v", err)
	}
	defer func() {
		_, _ = exec.CommandContext(context.Background(), "kubectl", "scale", "deployment", mockDeployment, "-n", mockNS, "--replicas=1").CombinedOutput()
	}()

	// Poll until HiveCluster status shows Connected=false
	deadline := time.Now().Add(degradedWait)
	for time.Now().Before(deadline) {
		out, err := exec.CommandContext(ctx, "kubectl", "get", "hivecluster", "hive-cluster", "-o", "jsonpath={.status.connected}").CombinedOutput()
		if err == nil && string(out) == "false" {
			break
		}
		time.Sleep(pollInterval)
	}
	if time.Now().After(deadline) {
		t.Fatalf("HiveCluster did not report Connected=false within %v", degradedWait)
	}

	// Assert worker deployment and pods unchanged (replicas still 1, deployment still exists)
	out, err := exec.CommandContext(ctx, "kubectl", "get", "deployment", "test-pool", "-n", tenantNS, "-o=name").CombinedOutput()
	if err != nil {
		t.Fatalf("get worker deployment: %v, %s", err, out)
	}
	if string(out) != "deployment.apps/test-pool\n" {
		t.Errorf("unexpected deployment output: %s", out)
	}
	out, err = exec.CommandContext(ctx, "kubectl", "get", "deployment", "test-pool", "-n", tenantNS, "-o", "jsonpath={.spec.replicas}").CombinedOutput()
	if err != nil || string(out) != "1" {
		t.Errorf("worker deployment replicas should still be 1: got %s, err %v", out, err)
	}
}
