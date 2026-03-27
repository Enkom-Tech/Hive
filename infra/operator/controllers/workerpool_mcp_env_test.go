package controllers

import (
	"testing"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	hivev1alpha1 "github.com/Enkom-Tech/hive-operator/api/v1alpha1"
)

func TestMcpCodeIndexerEnv_lexicographicPick(t *testing.T) {
	pool := &hivev1alpha1.HiveWorkerPool{
		Spec: hivev1alpha1.HiveWorkerPoolSpec{CompanyRef: "co"},
	}
	list := &hivev1alpha1.HiveIndexerList{
		Items: []hivev1alpha1.HiveIndexer{
			{
				ObjectMeta: metav1.ObjectMeta{Name: "b-index"},
				Spec:       hivev1alpha1.HiveIndexerSpec{CompanyRef: "co"},
				Status: hivev1alpha1.HiveIndexerStatus{
					Ready:             true,
					GatewayURL:        "http://gw-b",
					GatewaySecretName: "sec-b",
				},
			},
			{
				ObjectMeta: metav1.ObjectMeta{Name: "a-index"},
				Spec:       hivev1alpha1.HiveIndexerSpec{CompanyRef: "co"},
				Status: hivev1alpha1.HiveIndexerStatus{
					Ready:             true,
					GatewayURL:        "http://gw-a",
					GatewaySecretName: "sec-a",
				},
			},
		},
	}
	env, cond := mcpCodeIndexerEnv(pool, list)
	if cond.Status != metav1.ConditionTrue || cond.Reason != "Wired" {
		t.Fatalf("cond=%v", cond)
	}
	if len(env) != 4 {
		t.Fatalf("env len %d", len(env))
	}
	if env[0].Value != "http://gw-a/mcp" {
		t.Fatalf("expected a-index first, got %q", env[0].Value)
	}
}

func TestMcpCodeIndexerEnv_explicitName(t *testing.T) {
	pool := &hivev1alpha1.HiveWorkerPool{
		Spec: hivev1alpha1.HiveWorkerPoolSpec{CompanyRef: "co", CodeIndexerName: "b-index"},
	}
	list := &hivev1alpha1.HiveIndexerList{
		Items: []hivev1alpha1.HiveIndexer{
			{
				ObjectMeta: metav1.ObjectMeta{Name: "b-index"},
				Spec:       hivev1alpha1.HiveIndexerSpec{CompanyRef: "co"},
				Status: hivev1alpha1.HiveIndexerStatus{
					Ready:             true,
					GatewayURL:        "http://gw-b",
					GatewaySecretName: "sec-b",
				},
			},
			{
				ObjectMeta: metav1.ObjectMeta{Name: "a-index"},
				Spec:       hivev1alpha1.HiveIndexerSpec{CompanyRef: "co"},
				Status: hivev1alpha1.HiveIndexerStatus{
					Ready:             true,
					GatewayURL:        "http://gw-a",
					GatewaySecretName: "sec-a",
				},
			},
		},
	}
	env, cond := mcpCodeIndexerEnv(pool, list)
	if cond.Status != metav1.ConditionTrue {
		t.Fatal(cond)
	}
	if env[0].Value != "http://gw-b/mcp" {
		t.Fatalf("got %q", env[0].Value)
	}
}

func TestMcpCodeIndexerEnv_noIndexer(t *testing.T) {
	pool := &hivev1alpha1.HiveWorkerPool{Spec: hivev1alpha1.HiveWorkerPoolSpec{CompanyRef: "co"}}
	list := &hivev1alpha1.HiveIndexerList{Items: nil}
	_, cond := mcpCodeIndexerEnv(pool, list)
	if cond.Status != metav1.ConditionUnknown || cond.Reason != "NoHiveIndexer" {
		t.Fatalf("got %+v", cond)
	}
}

func TestMcpCodeIndexerEnv_indexerNotFound(t *testing.T) {
	pool := &hivev1alpha1.HiveWorkerPool{
		Spec: hivev1alpha1.HiveWorkerPoolSpec{CompanyRef: "co", CodeIndexerName: "missing"},
	}
	list := &hivev1alpha1.HiveIndexerList{
		Items: []hivev1alpha1.HiveIndexer{
			{ObjectMeta: metav1.ObjectMeta{Name: "a"}, Spec: hivev1alpha1.HiveIndexerSpec{CompanyRef: "co"}},
		},
	}
	_, cond := mcpCodeIndexerEnv(pool, list)
	if cond.Status != metav1.ConditionFalse || cond.Reason != "IndexerNotFound" {
		t.Fatalf("got %+v", cond)
	}
}

func TestMcpCodeIndexerEnv_gatewayIncomplete(t *testing.T) {
	pool := &hivev1alpha1.HiveWorkerPool{Spec: hivev1alpha1.HiveWorkerPoolSpec{CompanyRef: "co"}}
	list := &hivev1alpha1.HiveIndexerList{
		Items: []hivev1alpha1.HiveIndexer{
			{
				ObjectMeta: metav1.ObjectMeta{Name: "x"},
				Spec:       hivev1alpha1.HiveIndexerSpec{CompanyRef: "co"},
				Status:     hivev1alpha1.HiveIndexerStatus{Ready: true, GatewayURL: "", GatewaySecretName: "s"},
			},
		},
	}
	_, cond := mcpCodeIndexerEnv(pool, list)
	if cond.Status != metav1.ConditionFalse || cond.Reason != "GatewayIncomplete" {
		t.Fatalf("got %+v", cond)
	}
}

func TestMcpCodeIndexerEnv_waitingReady(t *testing.T) {
	pool := &hivev1alpha1.HiveWorkerPool{Spec: hivev1alpha1.HiveWorkerPoolSpec{CompanyRef: "co"}}
	list := &hivev1alpha1.HiveIndexerList{
		Items: []hivev1alpha1.HiveIndexer{
			{
				ObjectMeta: metav1.ObjectMeta{Name: "x"},
				Spec:       hivev1alpha1.HiveIndexerSpec{CompanyRef: "co"},
				Status: hivev1alpha1.HiveIndexerStatus{
					Ready:             false,
					GatewayURL:        "http://g",
					GatewaySecretName: "s",
				},
			},
		},
	}
	_, cond := mcpCodeIndexerEnv(pool, list)
	if cond.Status != metav1.ConditionUnknown || cond.Reason != "WaitingForIndexerReady" {
		t.Fatalf("got %+v", cond)
	}
}

func TestMcpDocIndexerEnv_wired(t *testing.T) {
	pool := &hivev1alpha1.HiveWorkerPool{Spec: hivev1alpha1.HiveWorkerPoolSpec{CompanyRef: "co"}}
	list := &hivev1alpha1.HiveDocIndexerList{
		Items: []hivev1alpha1.HiveDocIndexer{
			{
				ObjectMeta: metav1.ObjectMeta{Name: "d1"},
				Spec:       hivev1alpha1.HiveDocIndexerSpec{CompanyRef: "co"},
				Status: hivev1alpha1.HiveDocIndexerStatus{
					Ready:             true,
					GatewayURL:        "http://doc-gw",
					GatewaySecretName: "doc-sec",
				},
			},
		},
	}
	env, cond := mcpDocIndexerEnv(pool, list)
	if cond.Status != metav1.ConditionTrue || cond.Reason != "Wired" {
		t.Fatal(cond)
	}
	if len(env) != 2 || env[0].Name != "HIVE_MCP_DOCS_URL" || env[0].Value != "http://doc-gw/mcp" {
		t.Fatalf("env=%+v", env)
	}
	if env[1].Name != "HIVE_MCP_DOCS_TOKEN" || env[1].ValueFrom.SecretKeyRef.Name != "doc-sec" {
		t.Fatalf("token env=%+v", env[1])
	}
}

func TestMcpDocIndexerEnv_noDocIndexer(t *testing.T) {
	pool := &hivev1alpha1.HiveWorkerPool{Spec: hivev1alpha1.HiveWorkerPoolSpec{CompanyRef: "co"}}
	list := &hivev1alpha1.HiveDocIndexerList{}
	_, cond := mcpDocIndexerEnv(pool, list)
	if cond.Reason != "NoHiveDocIndexer" {
		t.Fatalf("got %+v", cond)
	}
}

func TestMcpDocIndexerEnv_docIndexerNotFound(t *testing.T) {
	pool := &hivev1alpha1.HiveWorkerPool{
		Spec: hivev1alpha1.HiveWorkerPoolSpec{CompanyRef: "co", DocIndexerName: "nope"},
	}
	list := &hivev1alpha1.HiveDocIndexerList{
		Items: []hivev1alpha1.HiveDocIndexer{
			{ObjectMeta: metav1.ObjectMeta{Name: "d1"}, Spec: hivev1alpha1.HiveDocIndexerSpec{CompanyRef: "co"}},
		},
	}
	_, cond := mcpDocIndexerEnv(pool, list)
	if cond.Reason != "IndexerNotFound" {
		t.Fatalf("got %+v", cond)
	}
}

func TestMcpCodeIndexerEnv_successEnvShape(t *testing.T) {
	pool := &hivev1alpha1.HiveWorkerPool{Spec: hivev1alpha1.HiveWorkerPoolSpec{CompanyRef: "co"}}
	list := &hivev1alpha1.HiveIndexerList{
		Items: []hivev1alpha1.HiveIndexer{
			{
				ObjectMeta: metav1.ObjectMeta{Name: "only"},
				Spec:       hivev1alpha1.HiveIndexerSpec{CompanyRef: "co"},
				Status: hivev1alpha1.HiveIndexerStatus{
					Ready:             true,
					GatewayURL:        "http://gw",
					GatewaySecretName: "sec1",
				},
			},
		},
	}
	env, cond := mcpCodeIndexerEnv(pool, list)
	if cond.Status != metav1.ConditionTrue {
		t.Fatal(cond)
	}
	if env[0].Value != "http://gw/mcp" {
		t.Fatalf("url %q", env[0].Value)
	}
	if env[1].ValueFrom.SecretKeyRef.Name != "sec1" || env[1].ValueFrom.SecretKeyRef.Key != "token" {
		t.Fatalf("token ref %+v", env[1].ValueFrom)
	}
}
