package v1alpha1

import (
	"encoding/json"
	"testing"
)

func TestHiveWorkerPool_JSONRoundTrip(t *testing.T) {
	p := &HiveWorkerPool{}
	p.Spec.CompanyRef = "acme"
	p.Spec.Replicas = 3
	p.Spec.WorkerImage = "hive-worker:latest"
	b, err := json.Marshal(p)
	if err != nil {
		t.Fatal(err)
	}
	var out HiveWorkerPool
	if err := json.Unmarshal(b, &out); err != nil {
		t.Fatal(err)
	}
	if out.Spec.CompanyRef != p.Spec.CompanyRef {
		t.Errorf("CompanyRef = %s", out.Spec.CompanyRef)
	}
	if out.Spec.Replicas != 3 {
		t.Errorf("Replicas = %d", out.Spec.Replicas)
	}
	if out.Spec.WorkerImage != "hive-worker:latest" {
		t.Errorf("WorkerImage = %s", out.Spec.WorkerImage)
	}
}

func TestHiveWorkerPool_ValidateCreate(t *testing.T) {
	tests := []struct {
		name    string
		spec    HiveWorkerPoolSpec
		wantErr bool
	}{
		{"valid", HiveWorkerPoolSpec{CompanyRef: "acme", Replicas: 1, WorkerImage: "hive-worker:v1"}, false},
		{"replicas 0", HiveWorkerPoolSpec{CompanyRef: "acme", Replicas: 0, WorkerImage: "img"}, false},
		{"replicas 50", HiveWorkerPoolSpec{CompanyRef: "acme", Replicas: 50, WorkerImage: "img"}, false},
		{"empty companyRef", HiveWorkerPoolSpec{CompanyRef: "", Replicas: 1, WorkerImage: "img"}, true},
		{"empty workerImage", HiveWorkerPoolSpec{CompanyRef: "acme", Replicas: 1, WorkerImage: ""}, true},
		{"replicas negative", HiveWorkerPoolSpec{CompanyRef: "acme", Replicas: -1, WorkerImage: "img"}, true},
		{"replicas over cap", HiveWorkerPoolSpec{CompanyRef: "acme", Replicas: 51, WorkerImage: "img"}, true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			p := &HiveWorkerPool{Spec: tt.spec}
			_, err := p.ValidateCreate()
			if (err != nil) != tt.wantErr {
				t.Errorf("ValidateCreate() error = %v, wantErr %v", err, tt.wantErr)
			}
		})
	}
}

func TestHiveWorkerPool_ValidateCreate_LatestWarning(t *testing.T) {
	p := &HiveWorkerPool{Spec: HiveWorkerPoolSpec{CompanyRef: "acme", Replicas: 1, WorkerImage: "hive-worker:latest"}}
	warnings, err := p.ValidateCreate()
	if err != nil {
		t.Fatal(err)
	}
	if len(warnings) != 1 {
		t.Errorf("expected 1 warning, got %d", len(warnings))
	}
}
