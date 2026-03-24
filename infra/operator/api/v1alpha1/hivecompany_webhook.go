package v1alpha1

import (
	"context"
	"fmt"
	"regexp"

	"k8s.io/apimachinery/pkg/api/resource"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/webhook/admission"
)

// uuidRegex matches a standard UUID (8-4-4-4-12 hex digits).
var uuidRegex = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

func (r *HiveCompany) SetupWebhookWithManager(mgr ctrl.Manager) error {
	return ctrl.NewWebhookManagedBy(mgr, r).WithValidator(r).Complete()
}

// +kubebuilder:webhook:path=/mutate-hive-io-v1alpha1-hivecompany,mutating=false,failurePolicy=fail,sideEffects=None,groups=hive.io,resources=hivecompanies,verbs=create;update,versions=v1alpha1,name=vhivecompany.kb.io,admissionReviewVersions=v1

var _ admission.Validator[*HiveCompany] = &HiveCompany{}

func (r *HiveCompany) validateSpec() (admission.Warnings, error) {
	if r.Spec.CompanyID == "" {
		return nil, fmt.Errorf("companyId is required")
	}
	if !uuidRegex.MatchString(r.Spec.CompanyID) {
		return nil, fmt.Errorf("companyId must be a valid UUID")
	}
	if r.Spec.StorageClass == "" {
		return nil, fmt.Errorf("storageClass is required")
	}
	if r.Spec.StorageSize == "" {
		return nil, fmt.Errorf("storageSize is required")
	}
	if _, err := resource.ParseQuantity(r.Spec.StorageSize); err != nil {
		return nil, fmt.Errorf("storageSize must be a valid quantity: %w", err)
	}
	return nil, nil
}

// ValidateCreate implements admission.Validator.
func (r *HiveCompany) ValidateCreate(ctx context.Context, obj *HiveCompany) (admission.Warnings, error) {
	return obj.validateSpec()
}

// ValidateUpdate implements admission.Validator. companyId is immutable.
func (r *HiveCompany) ValidateUpdate(ctx context.Context, oldObj, newObj *HiveCompany) (admission.Warnings, error) {
	if oldObj.Spec.CompanyID != newObj.Spec.CompanyID {
		return nil, fmt.Errorf("companyId is immutable")
	}
	return newObj.validateSpec()
}

// ValidateDelete implements admission.Validator.
func (r *HiveCompany) ValidateDelete(ctx context.Context, obj *HiveCompany) (admission.Warnings, error) {
	return nil, nil
}
