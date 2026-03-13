package v1alpha1

import (
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// HiveCompanySpec defines the desired state of HiveCompany.
type HiveCompanySpec struct {
	// CompanyID is the control plane company (tenant) identifier (UUID).
	// +kubebuilder:validation:Required
	// +kubebuilder:validation:Format=uuid
	CompanyID string `json:"companyId"`

	// StorageClass is the name of the StorageClass for the company PVC (e.g. juicefs-sc).
	// +kubebuilder:validation:Required
	StorageClass string `json:"storageClass"`

	// StorageSize is the requested size of the PVC (e.g. 50Gi).
	// +kubebuilder:validation:Required
	StorageSize string `json:"storageSize"`

	// CPUQuota is the namespace CPU quota (e.g. 10).
	// +optional
	CPUQuota string `json:"cpuQuota,omitempty"`

	// MemoryQuota is the namespace memory quota (e.g. 50Gi).
	// +optional
	MemoryQuota string `json:"memoryQuota,omitempty"`
}

// HiveCompanyStatus defines the observed state of HiveCompany.
type HiveCompanyStatus struct {
	// NamespaceReady is true when the tenant namespace exists.
	NamespaceReady bool `json:"namespaceReady"`

	// PVCReady is true when the company PVC is bound.
	PVCReady bool `json:"pvcReady"`

	// LastSyncAt is the last reconciliation time.
	// +optional
	LastSyncAt string `json:"lastSyncAt,omitempty"`

	// Conditions represent the latest available observations.
	// +optional
	Conditions []metav1.Condition `json:"conditions,omitempty" patchStrategy:"merge" patchMergeKey:"type"`
}

// +kubebuilder:object:root=true
// +kubebuilder:subresource:status
// +kubebuilder:printcolumn:name="CompanyID",type=string,JSONPath=`.spec.companyId`
// +kubebuilder:printcolumn:name="Namespace",type=string,JSONPath=`.status.namespaceReady`
// +kubebuilder:printcolumn:name="PVC",type=string,JSONPath=`.status.pvcReady`
// +kubebuilder:printcolumn:name="Age",type="date",JSONPath=".metadata.creationTimestamp"

// HiveCompany is the Schema for the hivecompanies API (per-company resources).
type HiveCompany struct {
	metav1.TypeMeta   `json:",inline"`
	metav1.ObjectMeta `json:"metadata,omitempty"`

	Spec   HiveCompanySpec   `json:"spec,omitempty"`
	Status HiveCompanyStatus `json:"status,omitempty"`
}

// +kubebuilder:object:root=true

// HiveCompanyList contains a list of HiveCompany.
type HiveCompanyList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitempty"`
	Items          []HiveCompany `json:"items"`
}
