package v1alpha1

import (
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// HiveWorkerPoolSpec defines the desired state of HiveWorkerPool.
type HiveWorkerPoolSpec struct {
	// CompanyRef is the name of the HiveCompany CR that owns this pool.
	// +kubebuilder:validation:Required
	CompanyRef string `json:"companyRef"`

	// Replicas is the desired number of worker pods (and control plane agents).
	// +kubebuilder:validation:Minimum=0
	// +kubebuilder:validation:Maximum=50
	// +kubebuilder:default=1
	Replicas int32 `json:"replicas"`

	// WorkerImage is the container image for the worker (e.g. ghcr.io/enkom/hive-worker:latest).
	// +kubebuilder:validation:Required
	WorkerImage string `json:"workerImage"`

	// NodeSelector for the worker Deployment.
	// +optional
	NodeSelector map[string]string `json:"nodeSelector,omitempty"`

	// Tolerations for the worker Deployment.
	// +optional
	Tolerations []corev1.Toleration `json:"tolerations,omitempty"`

	// Resources (limits/requests) for the worker container.
	// +optional
	Resources corev1.ResourceRequirements `json:"resources,omitempty"`

	// AdapterConfig holds extra HTTP adapter config keys (merged with url set by operator).
	// +optional
	AdapterConfig map[string]string `json:"adapterConfig,omitempty"`
}

// HiveWorkerPoolStatus defines the observed state of HiveWorkerPool.
type HiveWorkerPoolStatus struct {
	// ReadyReplicas is the number of worker pods that are ready.
	ReadyReplicas int32 `json:"readyReplicas"`

	// HealthyAgents is the number of agents reported healthy by the control plane.
	HealthyAgents int32 `json:"healthyAgents"`

	// LastSyncAt is the last reconciliation time.
	// +optional
	LastSyncAt string `json:"lastSyncAt,omitempty"`

	// SyncedAgentIDs is the list of control plane agent IDs managed by this pool.
	// +optional
	SyncedAgentIDs []string `json:"syncedAgentIds,omitempty"`

	// Conditions represent the latest available observations.
	// +optional
	Conditions []metav1.Condition `json:"conditions,omitempty" patchStrategy:"merge" patchMergeKey:"type"`
}

// +kubebuilder:object:root=true
// +kubebuilder:subresource:status
// +kubebuilder:printcolumn:name="Company",type=string,JSONPath=`.spec.companyRef`
// +kubebuilder:printcolumn:name="Replicas",type=integer,JSONPath=`.spec.replicas`
// +kubebuilder:printcolumn:name="Ready",type=integer,JSONPath=`.status.readyReplicas`
// +kubebuilder:printcolumn:name="Age",type="date",JSONPath=".metadata.creationTimestamp"

// HiveWorkerPool is the Schema for the hiveworkerpools API.
type HiveWorkerPool struct {
	metav1.TypeMeta   `json:",inline"`
	metav1.ObjectMeta `json:"metadata,omitempty"`

	Spec   HiveWorkerPoolSpec   `json:"spec,omitempty"`
	Status HiveWorkerPoolStatus `json:"status,omitempty"`
}

// +kubebuilder:object:root=true

// HiveWorkerPoolList contains a list of HiveWorkerPool.
type HiveWorkerPoolList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitempty"`
	Items          []HiveWorkerPool `json:"items"`
}
