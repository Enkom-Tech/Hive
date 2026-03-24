package v1alpha1

import (
	"context"
	"fmt"
	"net/url"

	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/webhook/admission"
)

func (r *HiveCluster) SetupWebhookWithManager(mgr ctrl.Manager) error {
	return ctrl.NewWebhookManagedBy(mgr, r).WithValidator(r).Complete()
}

// +kubebuilder:webhook:path=/mutate-hive-io-v1alpha1-hivecluster,mutating=false,failurePolicy=fail,sideEffects=None,groups=hive.io,resources=hiveclusters,verbs=create;update,versions=v1alpha1,name=vhivecluster.kb.io,admissionReviewVersions=v1

var _ admission.Validator[*HiveCluster] = &HiveCluster{}

func validateControlPlaneURL(s string) error {
	if s == "" {
		return fmt.Errorf("controlPlaneUrl is required")
	}
	u, err := url.Parse(s)
	if err != nil {
		return fmt.Errorf("controlPlaneUrl must be a valid URL: %w", err)
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return fmt.Errorf("controlPlaneUrl must use http or https")
	}
	if u.Host == "" {
		return fmt.Errorf("controlPlaneUrl must have a host")
	}
	return nil
}

// ValidateCreate implements admission.Validator so a webhook will be registered for the type.
func (r *HiveCluster) ValidateCreate(ctx context.Context, obj *HiveCluster) (admission.Warnings, error) {
	if err := validateControlPlaneURL(obj.Spec.ControlPlaneURL); err != nil {
		return nil, err
	}
	if obj.Spec.ProvisionerSecret == "" {
		return nil, fmt.Errorf("provisionerSecret is required")
	}
	return nil, nil
}

// ValidateUpdate implements admission.Validator so a webhook will be registered for the type.
func (r *HiveCluster) ValidateUpdate(ctx context.Context, oldObj, newObj *HiveCluster) (admission.Warnings, error) {
	return r.ValidateCreate(ctx, newObj)
}

// ValidateDelete implements admission.Validator so a webhook will be registered for the type.
func (r *HiveCluster) ValidateDelete(ctx context.Context, obj *HiveCluster) (admission.Warnings, error) {
	return nil, nil
}
