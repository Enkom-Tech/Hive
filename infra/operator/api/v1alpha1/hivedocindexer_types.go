package v1alpha1

import (
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// HiveDocIndexerSpec defines DocIndex API + parser worker + optional MCP gateway for a tenant.
type HiveDocIndexerSpec struct {
	// CompanyRef is the name of the HiveCompany CR this indexer serves.
	// +kubebuilder:validation:Required
	CompanyRef string `json:"companyRef"`

	// DocIndexImage is the container image for the DocIndex API (slim image; port 8082).
	// +kubebuilder:validation:Required
	DocIndexImage string `json:"docIndexImage"`

	// ParserWorkerImage is the heavy image that runs docindex_worker.py (Docling/Unstructured).
	// +kubebuilder:validation:Required
	ParserWorkerImage string `json:"parserWorkerImage"`

	// EmbeddingURL is the llama.cpp embedding server URL (cluster-internal).
	// +kubebuilder:validation:Required
	EmbeddingURL string `json:"embeddingUrl"`

	// EmbeddingDim is the vector dimension (default 4096 for Qwen3-Embedding-8B).
	// +kubebuilder:default=4096
	// +kubebuilder:validation:Minimum=1
	EmbeddingDim int32 `json:"embeddingDim"`

	// RedisURLSecretRef is the name of a Secret in the tenant namespace whose key "url"
	// holds the full Redis URL (e.g. redis://dragonfly:6379/0) for DOCINDEX_REDIS_URL.
	// +kubebuilder:validation:Required
	RedisURLSecretRef string `json:"redisUrlSecretRef"`

	// TokenSecretRef names a Secret with key "token" for DOCINDEX_API_TOKEN. If empty, generated.
	// +optional
	TokenSecretRef string `json:"tokenSecretRef,omitempty"`

	// JobSigningKeySecretRef names a Secret with key "key" for DOCINDEX_JOB_SIGNING_KEY. If empty, generated.
	// +optional
	JobSigningKeySecretRef string `json:"jobSigningKeySecretRef,omitempty"`

	// LanceDB PVC
	// +kubebuilder:default="20Gi"
	// +kubebuilder:validation:Required
	LanceDBStorageSize string `json:"lanceDbStorageSize"`

	// +kubebuilder:validation:Required
	LanceDBStorageClass string `json:"lanceDbStorageClass"`

	// Docs PVC (mounted read-write on API and worker)
	// +kubebuilder:default="50Gi"
	// +kubebuilder:validation:Required
	DocsStorageSize string `json:"docsStorageSize"`

	// +kubebuilder:validation:Required
	DocsStorageClass string `json:"docsStorageClass"`

	// GatewayImage for HTTP MCP gateway (worker-tier token). If empty, no gateway and no worker doc MCP env injection.
	// +optional
	GatewayImage string `json:"gatewayImage,omitempty"`

	// +optional
	Resources corev1.ResourceRequirements `json:"resources,omitempty"`

	// +optional
	WorkerResources corev1.ResourceRequirements `json:"workerResources,omitempty"`

	// +optional
	NodeSelector map[string]string `json:"nodeSelector,omitempty"`
}

// HiveDocIndexerStatus is observed state.
type HiveDocIndexerStatus struct {
	Ready bool `json:"ready"`

	// +optional
	LastSyncAt string `json:"lastSyncAt,omitempty"`

	// +optional
	TokenSecretName string `json:"tokenSecretName,omitempty"`

	// +optional
	ServiceURL string `json:"serviceUrl,omitempty"`

	// +optional
	GatewayURL string `json:"gatewayUrl,omitempty"`

	// +optional
	GatewaySecretName string `json:"gatewaySecretName,omitempty"`

	// Type IndexerDegraded: True when DocIndex API/worker Deployments or (if configured) MCP gateway Deployment lack ready replicas.
	// +optional
	Conditions []metav1.Condition `json:"conditions,omitempty" patchStrategy:"merge" patchMergeKey:"type"`
}

// +kubebuilder:object:root=true
// +kubebuilder:subresource:status
// +kubebuilder:printcolumn:name="Company",type=string,JSONPath=`.spec.companyRef`
// +kubebuilder:printcolumn:name="Ready",type=boolean,JSONPath=`.status.ready`
// +kubebuilder:printcolumn:name="Age",type="date",JSONPath=".metadata.creationTimestamp"

// HiveDocIndexer manages DocIndex (documents + LanceDB) for a HiveCompany tenant.
type HiveDocIndexer struct {
	metav1.TypeMeta   `json:",inline"`
	metav1.ObjectMeta `json:"metadata,omitempty"`

	Spec   HiveDocIndexerSpec   `json:"spec,omitempty"`
	Status HiveDocIndexerStatus `json:"status,omitempty"`
}

// +kubebuilder:object:root=true

// HiveDocIndexerList contains a list of HiveDocIndexer.
type HiveDocIndexerList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitempty"`
	Items           []HiveDocIndexer `json:"items"`
}
