package testutil

import (
	hivev1alpha1 "github.com/Enkom-Tech/hive-operator/api/v1alpha1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// HiveClusterFixture returns a minimal HiveCluster for tests.
func HiveClusterFixture(name, baseURL, secretName string) *hivev1alpha1.HiveCluster {
	return &hivev1alpha1.HiveCluster{
		ObjectMeta: metav1.ObjectMeta{Name: name},
		Spec: hivev1alpha1.HiveClusterSpec{
			ControlPlaneURL:   baseURL,
			ProvisionerSecret: secretName,
		},
	}
}

// HiveCompanyFixture returns a minimal HiveCompany for tests.
func HiveCompanyFixture(name, namespace, companyID string) *hivev1alpha1.HiveCompany {
	return &hivev1alpha1.HiveCompany{
		ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: namespace},
		Spec: hivev1alpha1.HiveCompanySpec{
			CompanyID:    companyID,
			StorageClass: "juicefs-sc",
			StorageSize:  "10Gi",
		},
	}
}

// HiveIndexerFixture returns a minimal HiveIndexer for integration tests (CocoIndex + LanceDB PVC).
func HiveIndexerFixture(name, namespace, companyRef string) *hivev1alpha1.HiveIndexer {
	return &hivev1alpha1.HiveIndexer{
		ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: namespace},
		Spec: hivev1alpha1.HiveIndexerSpec{
			CompanyRef:   companyRef,
			IndexerImage: "cocoindex:test",
			EmbeddingURL: "http://embeddings.test.svc.cluster.local:8080",
			EmbeddingDim: 4096,
			StorageSize:  "1Gi",
			StorageClass: "standard",
		},
	}
}

// HiveWorkerPoolFixture returns a minimal HiveWorkerPool for tests.
func HiveWorkerPoolFixture(name, namespace, companyRef, workerImage string, replicas int32) *hivev1alpha1.HiveWorkerPool {
	return &hivev1alpha1.HiveWorkerPool{
		ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: namespace},
		Spec: hivev1alpha1.HiveWorkerPoolSpec{
			CompanyRef:  companyRef,
			Replicas:    replicas,
			WorkerImage: workerImage,
		},
	}
}
