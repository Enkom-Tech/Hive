package v1alpha1

import (
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// HiveIndexerSpec defines the desired state of HiveIndexer.
type HiveIndexerSpec struct {
	// CompanyRef is the name of the HiveCompany CR this indexer serves.
	// The indexer is deployed in the company's tenant namespace (hive-tenant-<companyID>).
	// +kubebuilder:validation:Required
	CompanyRef string `json:"companyRef"`

	// IndexerImage is the container image for the CocoIndex service.
	// +kubebuilder:validation:Required
	IndexerImage string `json:"indexerImage"`

	// EmbeddingURL is the llama.cpp embedding server URL (cluster-internal service).
	// Example: http://llama-embeddings.cocoindex.svc.cluster.local:8080
	// +kubebuilder:validation:Required
	EmbeddingURL string `json:"embeddingUrl"`

	// EmbeddingDim is the vector dimension produced by the embedding model.
	// Must match the model loaded in the llama.cpp server (default: 4096 for Qwen3-Embedding-8B).
	// +kubebuilder:default=4096
	// +kubebuilder:validation:Minimum=1
	EmbeddingDim int32 `json:"embeddingDim"`

	// TokenSecretRef is the name of a K8s Secret in the same namespace that
	// contains the CocoIndex API token under key "token".
	// This token is injected as COCOINDEX_API_TOKEN into the indexer pod.
	// If empty, the operator generates a random token and creates the Secret.
	// +optional
	TokenSecretRef string `json:"tokenSecretRef,omitempty"`

	// DragonflySecretRef is the name of a K8s Secret that contains the DragonflyDB
	// password under key "password". If empty, DragonflyDB auth is not configured.
	// +optional
	DragonflySecretRef string `json:"dragonflySecretRef,omitempty"`

	// DragonflyURL is the DragonflyDB connection URL template.
	// The password placeholder is replaced at runtime from DragonflySecretRef.
	// Example: redis://dragonfly.hive-storage.svc.cluster.local:6379/0
	// +optional
	DragonflyURL string `json:"dragonflyUrl,omitempty"`

	// StorageSize is the PVC size for the LanceDB vector database.
	// +kubebuilder:default="20Gi"
	// +kubebuilder:validation:Required
	StorageSize string `json:"storageSize"`

	// StorageClass is the storage class for the LanceDB PVC.
	// Should be a fast local storage class (e.g. local-path, juicefs).
	// +kubebuilder:validation:Required
	StorageClass string `json:"storageClass"`

	// Languages is the comma-separated list of programming languages to index.
	// Supported: python, go, typescript, javascript, rust, java
	// +optional
	Languages []string `json:"languages,omitempty"`

	// Resources defines CPU/memory requests and limits for the indexer container.
	// Defaults: requests: {cpu: 1, memory: 4Gi}, limits: {cpu: 4, memory: 8Gi}
	// +optional
	Resources corev1.ResourceRequirements `json:"resources,omitempty"`

	// GatewayImage is the container image for the MCP gateway service.
	// The gateway is a lightweight proxy that validates worker tokens and
	// forwards approved calls to the indexer. If empty, no gateway is deployed
	// and worker injection is skipped.
	// +optional
	GatewayImage string `json:"gatewayImage,omitempty"`

	// NodeSelector for the indexer Deployment.
	// +optional
	NodeSelector map[string]string `json:"nodeSelector,omitempty"`
}

// HiveIndexerStatus defines the observed state of HiveIndexer.
type HiveIndexerStatus struct {
	// Ready is true when the indexer pod is running and responding to health checks.
	Ready bool `json:"ready"`

	// TotalChunks is the last-known count of indexed code chunks in LanceDB.
	// +optional
	TotalChunks int64 `json:"totalChunks,omitempty"`

	// LastSyncAt is the last time the reconciler successfully synced the indexer.
	// +optional
	LastSyncAt string `json:"lastSyncAt,omitempty"`

	// TokenSecretName is the name of the Secret holding the generated API token.
	// Workers in the same namespace should use this secret to authenticate to the indexer.
	// +optional
	TokenSecretName string `json:"tokenSecretName,omitempty"`

	// ServiceURL is the cluster-internal URL for the indexer API (admin, internal only).
	// +optional
	ServiceURL string `json:"serviceUrl,omitempty"`

	// GatewayURL is the cluster-internal URL for the MCP gateway service.
	// Workers inject this as HIVE_MCP_URL (points to gateway, not indexer directly).
	// +optional
	GatewayURL string `json:"gatewayUrl,omitempty"`

	// GatewaySecretName is the name of the Secret holding the worker-tier MCP token.
	// Workers inject this as HIVE_MCP_TOKEN via secretKeyRef.
	// +optional
	GatewaySecretName string `json:"gatewaySecretName,omitempty"`

	// Conditions represent the latest available observations of the indexer's state.
	// Type IndexerDegraded: True when the indexer Deployment or (if configured) MCP gateway Deployment has no ready replicas.
	// +optional
	Conditions []metav1.Condition `json:"conditions,omitempty" patchStrategy:"merge" patchMergeKey:"type"`
}

// +kubebuilder:object:root=true
// +kubebuilder:subresource:status
// +kubebuilder:printcolumn:name="Company",type=string,JSONPath=`.spec.companyRef`
// +kubebuilder:printcolumn:name="Ready",type=boolean,JSONPath=`.status.ready`
// +kubebuilder:printcolumn:name="Chunks",type=integer,JSONPath=`.status.totalChunks`
// +kubebuilder:printcolumn:name="Age",type="date",JSONPath=".metadata.creationTimestamp"

// HiveIndexer manages a CocoIndex semantic code indexing service for a HiveCompany tenant.
// Each HiveIndexer is scoped to one company and deployed in its tenant namespace,
// providing data isolation between tenants.
type HiveIndexer struct {
	metav1.TypeMeta   `json:",inline"`
	metav1.ObjectMeta `json:"metadata,omitempty"`

	Spec   HiveIndexerSpec   `json:"spec,omitempty"`
	Status HiveIndexerStatus `json:"status,omitempty"`
}

// +kubebuilder:object:root=true

// HiveIndexerList contains a list of HiveIndexer.
type HiveIndexerList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitempty"`
	Items           []HiveIndexer `json:"items"`
}
