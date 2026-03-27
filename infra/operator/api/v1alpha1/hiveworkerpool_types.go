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
	// Prefer an immutable digest reference (image@sha256:...) for reproducible deploys; the controller uses PullIfNotPresent for digests and PullAlways for mutable tags.
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

	// ModelGatewayURL is the OpenAI-compatible base URL for LLM inference (e.g. hive-model-gateway-go or Bifrost).
	// When set, the worker receives HIVE_MODEL_GATEWAY_URL so agents use this endpoint (must include /v1).
	// OpenAI-compatible clients also receive OPENAI_BASE_URL from this value when unset (see hive-worker executor).
	// +optional
	ModelGatewayURL string `json:"modelGatewayURL,omitempty"`

	// ModelGatewayCredentialSecret references a key in a tenant-namespace Secret for OPENAI_API_KEY (e.g. Bifrost sk-bf-*).
	// The Secret must exist in the same namespace as the worker pool; the control plane or a sync job should populate it — never put raw tokens in this CRD.
	// +optional
	ModelGatewayCredentialSecret *corev1.SecretKeySelector `json:"modelGatewayCredentialSecret,omitempty"`

	// CodeIndexerName is the metadata.name of the HiveIndexer to use for HIVE_MCP_CODE_* when multiple indexers exist for the company.
	// If empty, the operator selects the lexicographically first ready HiveIndexer that has a gateway URL and secret.
	// +optional
	CodeIndexerName string `json:"codeIndexerName,omitempty"`

	// DocIndexerName is the metadata.name of the HiveDocIndexer to use for HIVE_MCP_DOCS_* when multiple document indexers exist for the company.
	// If empty, the operator selects the lexicographically first ready HiveDocIndexer that has a gateway URL and secret.
	// +optional
	DocIndexerName string `json:"docIndexerName,omitempty"`
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
