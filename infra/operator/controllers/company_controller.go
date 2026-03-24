package controllers

import (
	"context"
	"time"

	corev1 "k8s.io/api/core/v1"
	netv1 "k8s.io/api/networking/v1"
	"k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/util/intstr"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/log"

	hivev1alpha1 "github.com/Enkom-Tech/hive-operator/api/v1alpha1"
)

// HiveCompanyReconciler reconciles a HiveCompany object.
type HiveCompanyReconciler struct {
	client.Client
	Scheme *runtime.Scheme
}

// +kubebuilder:rbac:groups=hive.io,resources=hivecompanies,verbs=get;list;watch
// +kubebuilder:rbac:groups=hive.io,resources=hivecompanies/status,verbs=get;update;patch
// +kubebuilder:rbac:groups="",resources=namespaces,verbs=get;list;create;delete
// +kubebuilder:rbac:groups="",resources=persistentvolumeclaims,verbs=get;list;create;update;patch;delete
// +kubebuilder:rbac:groups="",resources=resourcequotas,verbs=get;list;create;update;patch;delete
// +kubebuilder:rbac:groups=networking.k8s.io,resources=networkpolicies,verbs=get;list;create;update;patch;delete

const companyFinalizer = "hive.io/company-finalizer"

// Reconcile ensures namespace, PVC, ResourceQuota, and NetworkPolicy exist for the company.
func (r *HiveCompanyReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	logger := log.FromContext(ctx)
	company := &hivev1alpha1.HiveCompany{}
	if err := r.Get(ctx, req.NamespacedName, company); err != nil {
		if errors.IsNotFound(err) {
			return ctrl.Result{}, nil
		}
		return ctrl.Result{}, err
	}

	tenantNS := "hive-tenant-" + company.Spec.CompanyID

	if company.DeletionTimestamp != nil {
		if containsString(company.Finalizers, companyFinalizer) {
			ns := &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: tenantNS}}
			if err := r.Delete(ctx, ns); err != nil && !errors.IsNotFound(err) {
				return ctrl.Result{}, err
			}
			company.Finalizers = removeString(company.Finalizers, companyFinalizer)
			if err := r.Update(ctx, company); err != nil {
				return ctrl.Result{}, err
			}
		}
		return ctrl.Result{}, nil
	}

	if !containsString(company.Finalizers, companyFinalizer) {
		company.Finalizers = append(company.Finalizers, companyFinalizer)
		if err := r.Update(ctx, company); err != nil {
			return ctrl.Result{}, err
		}
		return ctrl.Result{}, nil
	}

	ns := &corev1.Namespace{
		ObjectMeta: metav1.ObjectMeta{
			Name: tenantNS,
			Labels: map[string]string{
				"hive.io/company-id": company.Spec.CompanyID,
			},
		},
	}
	if err := r.Create(ctx, ns); err != nil {
		if !errors.IsAlreadyExists(err) {
			logger.Error(err, "create namespace failed")
			return ctrl.Result{}, err
		}
	}
	company.Status.NamespaceReady = true

	pvcName := "workspace-" + company.Spec.CompanyID
	pvc := &corev1.PersistentVolumeClaim{
		ObjectMeta: metav1.ObjectMeta{Namespace: tenantNS, Name: pvcName},
		Spec: corev1.PersistentVolumeClaimSpec{
			AccessModes:      []corev1.PersistentVolumeAccessMode{corev1.ReadWriteOnce},
			StorageClassName: &company.Spec.StorageClass,
			Resources: corev1.VolumeResourceRequirements{
				Requests: corev1.ResourceList{
					corev1.ResourceStorage: resource.MustParse(company.Spec.StorageSize),
				},
			},
		},
	}
	if err := r.Create(ctx, pvc); err != nil {
		if !errors.IsAlreadyExists(err) {
			logger.Error(err, "create PVC failed")
			return ctrl.Result{RequeueAfter: 10 * time.Second}, nil
		}
	}
	company.Status.PVCReady = true

	if company.Spec.CPUQuota != "" || company.Spec.MemoryQuota != "" {
		quota := &corev1.ResourceQuota{
			ObjectMeta: metav1.ObjectMeta{Namespace: tenantNS, Name: "hive-quota"},
			Spec: corev1.ResourceQuotaSpec{
				Hard: corev1.ResourceList{},
			},
		}
		if company.Spec.CPUQuota != "" {
			quota.Spec.Hard[corev1.ResourceLimitsCPU] = resource.MustParse(company.Spec.CPUQuota)
		}
		if company.Spec.MemoryQuota != "" {
			quota.Spec.Hard[corev1.ResourceLimitsMemory] = resource.MustParse(company.Spec.MemoryQuota)
		}
		if err := r.Create(ctx, quota); err != nil && !errors.IsAlreadyExists(err) {
			logger.Error(err, "create ResourceQuota failed")
		}
	}

	udp := corev1.ProtocolUDP
	port := func(p int) *intstr.IntOrString { x := intstr.FromInt(p); return &x }

	// NetworkPolicy for the tenant namespace.
	// Ingress rules:
	//   1. Operator health checks: allow from hive-system on 8080.
	//   2. Workers → MCP gateway: allow pods with hive.io/role=worker to reach port 9090.
	//   3. Gateway → indexer: allow pods with hive.io/role=mcp-gateway to reach port 8080.
	//      Workers cannot reach the indexer on 8080 directly (no matching rule).
	// Egress rules:
	//   1. DNS to kube-system.
	//   2. Storage: MinIO (9000), DragonflyDB (6379) in hive-storage.
	//   3. External: HTTPS (443), Loki (3100).
	//   4. Workers → gateway: allow egress to pods with hive.io/role=mcp-gateway on 9090.
	//   5. Gateway → indexer: allow egress to pods with hive.io/role=indexer on 8080.
	npSpec := netv1.NetworkPolicySpec{
		PodSelector: metav1.LabelSelector{},
		PolicyTypes: []netv1.PolicyType{netv1.PolicyTypeIngress, netv1.PolicyTypeEgress},
		Ingress: []netv1.NetworkPolicyIngressRule{
			{
				From:  []netv1.NetworkPolicyPeer{{NamespaceSelector: &metav1.LabelSelector{MatchLabels: map[string]string{"hive.io/system": "true"}}}},
				Ports: []netv1.NetworkPolicyPort{{Port: port(8080)}},
			},
			{
				From:  []netv1.NetworkPolicyPeer{{PodSelector: &metav1.LabelSelector{MatchLabels: map[string]string{"hive.io/role": "worker"}}}},
				Ports: []netv1.NetworkPolicyPort{{Port: port(9090)}},
			},
			{
				From:  []netv1.NetworkPolicyPeer{{PodSelector: &metav1.LabelSelector{MatchLabels: map[string]string{"hive.io/role": "mcp-gateway"}}}},
				Ports: []netv1.NetworkPolicyPort{{Port: port(8080)}},
			},
		},
		Egress: []netv1.NetworkPolicyEgressRule{
			{To: []netv1.NetworkPolicyPeer{{NamespaceSelector: &metav1.LabelSelector{MatchLabels: map[string]string{"kubernetes.io/metadata.name": "kube-system"}}}}, Ports: []netv1.NetworkPolicyPort{{Port: port(53), Protocol: &udp}}},
			{To: []netv1.NetworkPolicyPeer{{NamespaceSelector: &metav1.LabelSelector{MatchLabels: map[string]string{"hive.io/storage": "true"}}}}, Ports: []netv1.NetworkPolicyPort{{Port: port(9000)}, {Port: port(6379)}}},
			{To: []netv1.NetworkPolicyPeer{{IPBlock: &netv1.IPBlock{CIDR: "0.0.0.0/0"}}}, Ports: []netv1.NetworkPolicyPort{{Port: port(443)}, {Port: port(3100)}}},
			{To: []netv1.NetworkPolicyPeer{{PodSelector: &metav1.LabelSelector{MatchLabels: map[string]string{"hive.io/role": "mcp-gateway"}}}}, Ports: []netv1.NetworkPolicyPort{{Port: port(9090)}}},
			{To: []netv1.NetworkPolicyPeer{{PodSelector: &metav1.LabelSelector{MatchLabels: map[string]string{"hive.io/role": "indexer"}}}}, Ports: []netv1.NetworkPolicyPort{{Port: port(8080)}}},
		},
	}
	np := &netv1.NetworkPolicy{
		ObjectMeta: metav1.ObjectMeta{Namespace: tenantNS, Name: "hive-tenant-default"},
		Spec:       npSpec,
	}
	if err := r.Create(ctx, np); err != nil {
		if errors.IsAlreadyExists(err) {
			existing := &netv1.NetworkPolicy{}
			if r.Get(ctx, client.ObjectKey{Namespace: tenantNS, Name: "hive-tenant-default"}, existing) == nil {
				existing.Spec = npSpec
				if err := r.Update(ctx, existing); err != nil {
					logger.Error(err, "update NetworkPolicy failed")
				}
			}
		} else {
			logger.Error(err, "create NetworkPolicy failed")
		}
	}

	company.Status.LastSyncAt = metav1.Now().Format(time.RFC3339)
	_ = r.Status().Update(ctx, company)
	return ctrl.Result{RequeueAfter: 60 * time.Second}, nil
}

func containsString(slice []string, s string) bool {
	for _, v := range slice {
		if v == s {
			return true
		}
	}
	return false
}

func removeString(slice []string, s string) []string {
	var out []string
	for _, v := range slice {
		if v != s {
			out = append(out, v)
		}
	}
	return out
}

// SetupWithManager sets up the controller with the Manager.
func (r *HiveCompanyReconciler) SetupWithManager(mgr ctrl.Manager) error {
	return ctrl.NewControllerManagedBy(mgr).
		For(&hivev1alpha1.HiveCompany{}).
		Complete(r)
}
