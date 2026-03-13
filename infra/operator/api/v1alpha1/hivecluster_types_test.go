package v1alpha1

import (
	"encoding/json"
	"testing"
)

func TestHiveCluster_JSONRoundTrip(t *testing.T) {
	c := &HiveCluster{}
	c.Spec.ControlPlaneURL = "https://api.example.com"
	c.Spec.ProvisionerSecret = "provisioner-token"
	c.Spec.DefaultNodeSelector = map[string]string{"location": "cloud"}
	b, err := json.Marshal(c)
	if err != nil {
		t.Fatal(err)
	}
	var out HiveCluster
	if err := json.Unmarshal(b, &out); err != nil {
		t.Fatal(err)
	}
	if out.Spec.ControlPlaneURL != c.Spec.ControlPlaneURL {
		t.Errorf("ControlPlaneURL = %s", out.Spec.ControlPlaneURL)
	}
	if out.Spec.ProvisionerSecret != c.Spec.ProvisionerSecret {
		t.Errorf("ProvisionerSecret = %s", out.Spec.ProvisionerSecret)
	}
	if out.Spec.DefaultNodeSelector["location"] != "cloud" {
		t.Errorf("DefaultNodeSelector = %v", out.Spec.DefaultNodeSelector)
	}
}

func TestHiveCluster_ValidateCreate(t *testing.T) {
	tests := []struct {
		name    string
		spec    HiveClusterSpec
		wantErr bool
	}{
		{"valid", HiveClusterSpec{ControlPlaneURL: "https://api.example.com", ProvisionerSecret: "token"}, false},
		{"valid http", HiveClusterSpec{ControlPlaneURL: "http://localhost:3100", ProvisionerSecret: "token"}, false},
		{"empty url", HiveClusterSpec{ControlPlaneURL: "", ProvisionerSecret: "token"}, true},
		{"invalid url", HiveClusterSpec{ControlPlaneURL: "not-a-url", ProvisionerSecret: "token"}, true},
		{"wrong scheme", HiveClusterSpec{ControlPlaneURL: "ftp://host", ProvisionerSecret: "token"}, true},
		{"empty secret", HiveClusterSpec{ControlPlaneURL: "https://api.example.com", ProvisionerSecret: ""}, true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			c := &HiveCluster{Spec: tt.spec}
			_, err := c.ValidateCreate()
			if (err != nil) != tt.wantErr {
				t.Errorf("ValidateCreate() error = %v, wantErr %v", err, tt.wantErr)
			}
		})
	}
}
