package v1alpha1

import (
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// HiveClusterSpec defines the desired state of HiveCluster.
// +kubebuilder:validation:Required
type HiveClusterSpec struct {
	// ControlPlaneURL is the URL of the Squadron (future: Hive) control plane API.
	// +kubebuilder:validation:Required
	// +kubebuilder:validation:Format=uri
	ControlPlaneURL string `json:"controlPlaneUrl"`

	// ProvisionerSecret is the name of a K8s Secret (in the same namespace as the operator)
	// containing the board-level API token (key: token).
	// +kubebuilder:validation:Required
	ProvisionerSecret string `json:"provisionerSecret"`

	// DefaultNodeSelector applied to worker Deployments when not overridden by HiveWorkerPool.
	// +optional
	DefaultNodeSelector map[string]string `json:"defaultNodeSelector,omitempty"`
}

// HiveClusterStatus defines the observed state of HiveCluster.
type HiveClusterStatus struct {
	// Connected is true when the control plane API is reachable.
	Connected bool `json:"connected"`

	// LastSyncAt is the last time the operator successfully talked to the control plane.
	// +optional
	LastSyncAt string `json:"lastSyncAt,omitempty"`

	// APIVersion is the control plane API version string (e.g. from /api/health).
	// +optional
	APIVersion string `json:"apiVersion,omitempty"`

	// Conditions represent the latest available observations.
	// +optional
	Conditions []metav1.Condition `json:"conditions,omitempty" patchStrategy:"merge" patchMergeKey:"type"`
}

// +kubebuilder:object:root=true
// +kubebuilder:resource:scope=Cluster
// +kubebuilder:subresource:status
// +kubebuilder:printcolumn:name="Connected",type=string,JSONPath=`.status.connected`
// +kubebuilder:printcolumn:name="Age",type="date",JSONPath=".metadata.creationTimestamp"

// HiveCluster is the Schema for the hiveclusters API (cluster-scoped singleton).
type HiveCluster struct {
	metav1.TypeMeta   `json:",inline"`
	metav1.ObjectMeta `json:"metadata,omitempty"`

	Spec   HiveClusterSpec   `json:"spec,omitempty"`
	Status HiveClusterStatus `json:"status,omitempty"`
}

// +kubebuilder:object:root=true

// HiveClusterList contains a list of HiveCluster.
type HiveClusterList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitempty"`
	Items          []HiveCluster `json:"items"`
}
