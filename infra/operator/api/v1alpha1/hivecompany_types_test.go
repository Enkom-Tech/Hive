package v1alpha1

import (
	"encoding/json"
	"testing"
)

func TestHiveCompany_JSONRoundTrip(t *testing.T) {
	c := &HiveCompany{}
	c.Spec.CompanyID = "550e8400-e29b-41d4-a716-446655440000"
	c.Spec.StorageClass = "juicefs-sc"
	c.Spec.StorageSize = "50Gi"
	b, err := json.Marshal(c)
	if err != nil {
		t.Fatal(err)
	}
	var out HiveCompany
	if err := json.Unmarshal(b, &out); err != nil {
		t.Fatal(err)
	}
	if out.Spec.CompanyID != c.Spec.CompanyID {
		t.Errorf("CompanyID = %s", out.Spec.CompanyID)
	}
	if out.Spec.StorageSize != "50Gi" {
		t.Errorf("StorageSize = %s", out.Spec.StorageSize)
	}
}

func TestHiveCompany_ValidateCreate(t *testing.T) {
	validUUID := "550e8400-e29b-41d4-a716-446655440000"
	tests := []struct {
		name    string
		spec    HiveCompanySpec
		wantErr bool
	}{
		{"valid", HiveCompanySpec{CompanyID: validUUID, StorageClass: "juicefs-sc", StorageSize: "50Gi"}, false},
		{"empty companyId", HiveCompanySpec{CompanyID: "", StorageClass: "sc", StorageSize: "10Gi"}, true},
		{"invalid uuid", HiveCompanySpec{CompanyID: "not-a-uuid", StorageClass: "sc", StorageSize: "10Gi"}, true},
		{"invalid quantity", HiveCompanySpec{CompanyID: validUUID, StorageClass: "sc", StorageSize: "invalid"}, true},
		{"empty storageClass", HiveCompanySpec{CompanyID: validUUID, StorageClass: "", StorageSize: "10Gi"}, true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			c := &HiveCompany{Spec: tt.spec}
			_, err := c.ValidateCreate()
			if (err != nil) != tt.wantErr {
				t.Errorf("ValidateCreate() error = %v, wantErr %v", err, tt.wantErr)
			}
		})
	}
}

func TestHiveCompany_ValidateUpdate_ImmutableCompanyID(t *testing.T) {
	old := &HiveCompany{Spec: HiveCompanySpec{CompanyID: "550e8400-e29b-41d4-a716-446655440000", StorageClass: "sc", StorageSize: "10Gi"}}
	new := &HiveCompany{Spec: HiveCompanySpec{CompanyID: "660e8400-e29b-41d4-a716-446655440000", StorageClass: "sc", StorageSize: "10Gi"}}
	_, err := new.ValidateUpdate(old)
	if err == nil {
		t.Error("expected error when companyId changes")
	}
}
