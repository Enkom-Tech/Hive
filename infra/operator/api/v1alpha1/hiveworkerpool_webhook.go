package v1alpha1

import (
	"context"
	"fmt"
	"strings"

	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/webhook/admission"
)

const maxReplicas = 50

func (r *HiveWorkerPool) SetupWebhookWithManager(mgr ctrl.Manager) error {
	return ctrl.NewWebhookManagedBy(mgr, r).WithValidator(r).Complete()
}

// +kubebuilder:webhook:path=/mutate-hive-io-v1alpha1-hiveworkerpool,mutating=false,failurePolicy=fail,sideEffects=None,groups=hive.io,resources=hiveworkerpools,verbs=create;update,versions=v1alpha1,name=vhiveworkerpool.kb.io,admissionReviewVersions=v1

var _ admission.Validator[*HiveWorkerPool] = &HiveWorkerPool{}

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

// ValidateCreate implements admission.Validator.
func (r *HiveWorkerPool) ValidateCreate(ctx context.Context, obj *HiveWorkerPool) (admission.Warnings, error) {
	warnings, err := obj.validateSpec()
	if err != nil {
		return warnings, err
	}
	if strings.HasSuffix(obj.Spec.WorkerImage, ":latest") {
		warnings = append(warnings, "workerImage should not use :latest tag in production")
	}
	return warnings, nil
}

// ValidateUpdate implements admission.Validator.
func (r *HiveWorkerPool) ValidateUpdate(ctx context.Context, oldObj, newObj *HiveWorkerPool) (admission.Warnings, error) {
	return r.ValidateCreate(ctx, newObj)
}

// ValidateDelete implements admission.Validator.
func (r *HiveWorkerPool) ValidateDelete(ctx context.Context, obj *HiveWorkerPool) (admission.Warnings, error) {
	return nil, nil
}
