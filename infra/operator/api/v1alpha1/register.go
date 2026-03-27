package v1alpha1

import (
	"k8s.io/apimachinery/pkg/runtime/schema"
	"sigs.k8s.io/controller-runtime/pkg/scheme"
)

var (
	GroupVersion  = schema.GroupVersion{Group: Group, Version: Version}
	SchemeBuilder = &scheme.Builder{GroupVersion: GroupVersion}
	AddToScheme   = SchemeBuilder.AddToScheme
)

func init() {
	SchemeBuilder.Register(
		&HiveCluster{}, &HiveClusterList{},
		&HiveCompany{}, &HiveCompanyList{},
		&HiveWorkerPool{}, &HiveWorkerPoolList{},
		&HiveIndexer{}, &HiveIndexerList{},
		&HiveDocIndexer{}, &HiveDocIndexerList{},
	)
}
