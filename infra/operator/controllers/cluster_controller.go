package controllers

import (
	"context"
	"time"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/log"

	hivev1alpha1 "github.com/Enkom-Tech/hive-operator/api/v1alpha1"
	"github.com/Enkom-Tech/hive-operator/internal/controlplane"
)

const provisionerSecretNamespace = "hive-system"

// HiveClusterReconciler reconciles a HiveCluster object.
type HiveClusterReconciler struct {
	client.Client
	Scheme *runtime.Scheme
}

// +kubebuilder:rbac:groups=hive.io,resources=hiveclusters,verbs=get;list;watch
// +kubebuilder:rbac:groups=hive.io,resources=hiveclusters/status,verbs=get;update;patch
// +kubebuilder:rbac:groups="",resources=secrets,verbs=get;list

// Reconcile validates control plane API connectivity and updates status.
func (r *HiveClusterReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	logger := log.FromContext(ctx)
	cluster := &hivev1alpha1.HiveCluster{}
	if err := r.Get(ctx, req.NamespacedName, cluster); err != nil {
		if errors.IsNotFound(err) {
			return ctrl.Result{}, nil
		}
		return ctrl.Result{}, err
	}

	secret := &corev1.Secret{}
	if err := r.Get(ctx, client.ObjectKey{Namespace: provisionerSecretNamespace, Name: cluster.Spec.ProvisionerSecret}, secret); err != nil {
		if errors.IsNotFound(err) {
			logger.Info("provisioner secret not found", "secret", cluster.Spec.ProvisionerSecret)
			cluster.Status.Connected = false
			cluster.Status.LastSyncAt = metav1.Now().Format(time.RFC3339)
			_ = r.Status().Update(ctx, cluster)
			return ctrl.Result{RequeueAfter: 30 * time.Second}, nil
		}
		return ctrl.Result{}, err
	}
	tokenBytes := secret.Data["token"]
	if len(tokenBytes) == 0 {
		tokenBytes = secret.Data["apiKey"]
	}
	token := string(tokenBytes)

	cp := controlplane.NewClient(cluster.Spec.ControlPlaneURL, token)
	code, err := cp.Health(ctx)
	if err != nil || code != 200 {
		cluster.Status.Connected = false
		cluster.Status.LastSyncAt = metav1.Now().Format(time.RFC3339)
		_ = r.Status().Update(ctx, cluster)
		return ctrl.Result{RequeueAfter: 30 * time.Second}, nil
	}

	cluster.Status.Connected = true
	cluster.Status.LastSyncAt = metav1.Now().Format(time.RFC3339)
	cluster.Status.APIVersion = "v1"
	_ = r.Status().Update(ctx, cluster)
	return ctrl.Result{RequeueAfter: 60 * time.Second}, nil
}

// SetupWithManager sets up the controller with the Manager.
func (r *HiveClusterReconciler) SetupWithManager(mgr ctrl.Manager) error {
	return ctrl.NewControllerManagedBy(mgr).
		For(&hivev1alpha1.HiveCluster{}).
		Complete(r)
}
