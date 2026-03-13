package v1alpha1

import (
	"fmt"
	"strings"

	"k8s.io/apimachinery/pkg/runtime"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/webhook"
	"sigs.k8s.io/controller-runtime/pkg/webhook/admission"
)

const maxReplicas = 50

func (r *HiveWorkerPool) SetupWebhookWithManager(mgr ctrl.Manager) error {
	return ctrl.NewWebhookManagedBy(mgr).
		For(r).
		Complete()
}

// +kubebuilder:webhook:path=/mutate-hive-io-v1alpha1-hiveworkerpool,mutating=false,failurePolicy=fail,sideEffects=None,groups=hive.io,resources=hiveworkerpools,verbs=create;update,versions=v1alpha1,name=vhiveworkerpool.kb.io,admissionReviewVersions=v1

var _ webhook.Validator = &HiveWorkerPool{}

func (r *HiveWorkerPool) validateSpec() (admission.Warnings, error) {
	if r.Spec.CompanyRef == "" {
		return nil, fmt.Errorf("companyRef is required")
	}
	if r.Spec.WorkerImage == "" {
		return nil, fmt.Errorf("workerImage is required")
	}
	if r.Spec.Replicas < 0 || r.Spec.Replicas > maxReplicas {
		return nil, fmt.Errorf("replicas must be between 0 and %d", maxReplicas)
	}
	return nil, nil
}

// ValidateCreate implements webhook.Validator.
func (r *HiveWorkerPool) ValidateCreate() (admission.Warnings, error) {
	warnings, err := r.validateSpec()
	if err != nil {
		return warnings, err
	}
	if strings.HasSuffix(r.Spec.WorkerImage, ":latest") {
		warnings = append(warnings, "workerImage should not use :latest tag in production")
	}
	return warnings, nil
}

// ValidateUpdate implements webhook.Validator.
func (r *HiveWorkerPool) ValidateUpdate(old runtime.Object) (admission.Warnings, error) {
	return r.ValidateCreate()
}

// ValidateDelete implements webhook.Validator.
func (r *HiveWorkerPool) ValidateDelete() (admission.Warnings, error) {
	return nil, nil
}
