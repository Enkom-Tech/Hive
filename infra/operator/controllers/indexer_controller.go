package controllers

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"time"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
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

const (
	indexerFinalizer      = "hive.io/indexer-finalizer"
	indexerManagedByLabel = "managed-by"
	indexerManagedByValue = "hive-operator"
)

// HiveIndexerReconciler reconciles a HiveIndexer object.
type HiveIndexerReconciler struct {
	client.Client
	Scheme *runtime.Scheme
}

// +kubebuilder:rbac:groups=hive.io,resources=hiveindexers,verbs=get;list;watch
// +kubebuilder:rbac:groups=hive.io,resources=hiveindexers/status,verbs=get;update;patch
// +kubebuilder:rbac:groups=hive.io,resources=hivecompanies,verbs=get;list;watch
// +kubebuilder:rbac:groups="",resources=secrets,verbs=get;list;create;update;patch;delete
// +kubebuilder:rbac:groups="",resources=persistentvolumeclaims,verbs=get;list;create;update;patch
// +kubebuilder:rbac:groups=apps,resources=deployments,verbs=get;list;create;update;patch;delete
// +kubebuilder:rbac:groups="",resources=services,verbs=get;list;create;update;patch

// Reconcile manages the CocoIndex deployment lifecycle for a HiveIndexer CR.
func (r *HiveIndexerReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	logger := log.FromContext(ctx)

	indexer := &hivev1alpha1.HiveIndexer{}
	if err := r.Get(ctx, req.NamespacedName, indexer); err != nil {
		if errors.IsNotFound(err) {
			return ctrl.Result{}, nil
		}
		return ctrl.Result{}, err
	}

	// Handle deletion via finalizer
	if !indexer.DeletionTimestamp.IsZero() {
		return r.handleDeletion(ctx, indexer)
	}

	// Register finalizer
	if !containsString(indexer.Finalizers, indexerFinalizer) {
		indexer.Finalizers = append(indexer.Finalizers, indexerFinalizer)
		if err := r.Update(ctx, indexer); err != nil {
			return ctrl.Result{}, err
		}
	}

	// Resolve the HiveCompany to get the tenant namespace and companyID
	company := &hivev1alpha1.HiveCompany{}
	if err := r.Get(ctx, client.ObjectKey{Namespace: req.Namespace, Name: indexer.Spec.CompanyRef}, company); err != nil {
		if errors.IsNotFound(err) {
			logger.Info("HiveCompany not found, requeueing", "companyRef", indexer.Spec.CompanyRef)
			return ctrl.Result{RequeueAfter: 15 * time.Second}, nil
		}
		return ctrl.Result{}, err
	}

	tenantNS := "hive-tenant-" + company.Spec.CompanyID

	// Ensure API token Secret exists (generate if absent)
	tokenSecretName := indexer.Name + "-api-token"
	if indexer.Spec.TokenSecretRef != "" {
		tokenSecretName = indexer.Spec.TokenSecretRef
	}
	if err := r.ensureTokenSecret(ctx, indexer, tenantNS, tokenSecretName); err != nil {
		logger.Error(err, "failed to ensure token secret")
		return ctrl.Result{RequeueAfter: 15 * time.Second}, nil
	}

	// Ensure LanceDB PVC
	pvcName := "lancedb-" + company.Spec.CompanyID
	if err := r.ensureLanceDBPVC(ctx, indexer, tenantNS, pvcName); err != nil {
		logger.Error(err, "failed to ensure LanceDB PVC")
		return ctrl.Result{RequeueAfter: 15 * time.Second}, nil
	}

	// Ensure indexer Deployment (pod label: hive.io/role=indexer)
	svcURL := fmt.Sprintf("http://%s.%s.svc.cluster.local:8080", indexer.Name, tenantNS)
	if err := r.ensureDeployment(ctx, indexer, tenantNS, tokenSecretName, pvcName, company.Spec.CompanyID); err != nil {
		logger.Error(err, "failed to ensure indexer Deployment")
		return ctrl.Result{RequeueAfter: 15 * time.Second}, nil
	}

	// Ensure indexer Service
	if err := r.ensureService(ctx, indexer, tenantNS); err != nil {
		logger.Error(err, "failed to ensure indexer Service")
		return ctrl.Result{RequeueAfter: 15 * time.Second}, nil
	}

	// Ensure MCP gateway resources (only when GatewayImage is specified)
	var gatewayURL, gatewaySecretName string
	if indexer.Spec.GatewayImage != "" {
		gatewaySecretName = indexer.Name + "-worker-token"
		if err := r.ensureWorkerTokenSecret(ctx, tenantNS, gatewaySecretName); err != nil {
			logger.Error(err, "failed to ensure worker token secret")
			return ctrl.Result{RequeueAfter: 15 * time.Second}, nil
		}
		gatewayName := indexer.Name + "-gateway"
		if err := r.ensureGatewayDeployment(ctx, indexer, tenantNS, gatewayName, tokenSecretName, gatewaySecretName); err != nil {
			logger.Error(err, "failed to ensure gateway Deployment")
			return ctrl.Result{RequeueAfter: 15 * time.Second}, nil
		}
		if err := r.ensureGatewayService(ctx, tenantNS, gatewayName); err != nil {
			logger.Error(err, "failed to ensure gateway Service")
			return ctrl.Result{RequeueAfter: 15 * time.Second}, nil
		}
		gatewayURL = fmt.Sprintf("http://%s.%s.svc.cluster.local:9090", gatewayName, tenantNS)
	}

	// Update status
	indexer.Status.TokenSecretName = tokenSecretName
	indexer.Status.ServiceURL = svcURL
	indexer.Status.GatewayURL = gatewayURL
	indexer.Status.GatewaySecretName = gatewaySecretName
	indexer.Status.LastSyncAt = metav1.Now().Format(time.RFC3339)

	dep := &appsv1.Deployment{}
	dataPlaneReady := false
	if err := r.Get(ctx, client.ObjectKey{Namespace: tenantNS, Name: indexer.Name}, dep); err == nil {
		dataPlaneReady = dep.Status.ReadyReplicas > 0
		indexer.Status.Ready = dataPlaneReady
	} else {
		indexer.Status.Ready = false
	}

	gatewayReady := true
	if indexer.Spec.GatewayImage != "" {
		gatewayName := indexer.Name + "-gateway"
		gwDep := &appsv1.Deployment{}
		if err := r.Get(ctx, client.ObjectKey{Namespace: tenantNS, Name: gatewayName}, gwDep); err != nil {
			gatewayReady = false
		} else {
			gatewayReady = gwDep.Status.ReadyReplicas > 0
		}
	}
	applyIndexerDegradedCondition(&indexer.Status.Conditions, dataPlaneReady, indexer.Spec.GatewayImage != "", gatewayReady, indexer.Generation)

	_ = r.Status().Update(ctx, indexer)
	return ctrl.Result{RequeueAfter: 60 * time.Second}, nil
}

func (r *HiveIndexerReconciler) handleDeletion(ctx context.Context, indexer *hivev1alpha1.HiveIndexer) (ctrl.Result, error) {
	logger := log.FromContext(ctx)

	company := &hivev1alpha1.HiveCompany{}
	if err := r.Get(ctx, client.ObjectKey{Namespace: indexer.Namespace, Name: indexer.Spec.CompanyRef}, company); err == nil {
		tenantNS := "hive-tenant-" + company.Spec.CompanyID

		// Delete the Deployment
		dep := &appsv1.Deployment{}
		dep.Namespace = tenantNS
		dep.Name = indexer.Name
		if err := r.Delete(ctx, dep); err != nil && !errors.IsNotFound(err) {
			logger.Error(err, "failed to delete indexer Deployment during cleanup")
		}

		// Delete the Service
		svc := &corev1.Service{}
		svc.Namespace = tenantNS
		svc.Name = indexer.Name
		if err := r.Delete(ctx, svc); err != nil && !errors.IsNotFound(err) {
			logger.Error(err, "failed to delete indexer Service during cleanup")
		}

		// Delete the admin token Secret (do NOT delete the PVC — it holds the index data;
		// leave it for the operator admin to manually delete to prevent data loss)
		tokenSecretName := indexer.Name + "-api-token"
		if indexer.Spec.TokenSecretRef != "" {
			tokenSecretName = indexer.Spec.TokenSecretRef
		}
		tokenSecret := &corev1.Secret{ObjectMeta: metav1.ObjectMeta{Namespace: tenantNS, Name: tokenSecretName}}
		if err := r.Delete(ctx, tokenSecret); err != nil && !errors.IsNotFound(err) {
			logger.Error(err, "failed to delete token secret during cleanup")
		}

		// Delete gateway resources if they exist
		if indexer.Spec.GatewayImage != "" {
			gatewayName := indexer.Name + "-gateway"
			gatewayDep := &appsv1.Deployment{ObjectMeta: metav1.ObjectMeta{Namespace: tenantNS, Name: gatewayName}}
			if err := r.Delete(ctx, gatewayDep); err != nil && !errors.IsNotFound(err) {
				logger.Error(err, "failed to delete gateway Deployment during cleanup")
			}
			gatewaySvc := &corev1.Service{ObjectMeta: metav1.ObjectMeta{Namespace: tenantNS, Name: gatewayName}}
			if err := r.Delete(ctx, gatewaySvc); err != nil && !errors.IsNotFound(err) {
				logger.Error(err, "failed to delete gateway Service during cleanup")
			}
			workerTokenSecret := &corev1.Secret{ObjectMeta: metav1.ObjectMeta{Namespace: tenantNS, Name: indexer.Name + "-worker-token"}}
			if err := r.Delete(ctx, workerTokenSecret); err != nil && !errors.IsNotFound(err) {
				logger.Error(err, "failed to delete worker token secret during cleanup")
			}
		}
	}

	// Remove finalizer
	indexer.Finalizers = removeString(indexer.Finalizers, indexerFinalizer)
	return ctrl.Result{}, r.Update(ctx, indexer)
}

// ensureTokenSecret creates a Secret with a random API token if one does not exist.
// The token is cryptographically random (32 hex chars = 128 bits of entropy).
func (r *HiveIndexerReconciler) ensureTokenSecret(ctx context.Context, indexer *hivev1alpha1.HiveIndexer, ns, name string) error {
	secret := &corev1.Secret{}
	err := r.Get(ctx, client.ObjectKey{Namespace: ns, Name: name}, secret)
	if err == nil {
		return nil // already exists
	}
	if !errors.IsNotFound(err) {
		return err
	}

	// Generate 32-byte (256-bit) cryptographically random token
	tokenBytes := make([]byte, 32)
	if _, err := rand.Read(tokenBytes); err != nil {
		return fmt.Errorf("generate token: %w", err)
	}
	token := hex.EncodeToString(tokenBytes)

	secret = &corev1.Secret{
		ObjectMeta: metav1.ObjectMeta{
			Namespace: ns,
			Name:      name,
			Labels: map[string]string{
				indexerManagedByLabel: indexerManagedByValue,
			},
		},
		StringData: map[string]string{
			"token": token,
		},
	}
	return r.Create(ctx, secret)
}

// ensureLanceDBPVC creates the PVC for LanceDB vector storage if absent.
func (r *HiveIndexerReconciler) ensureLanceDBPVC(ctx context.Context, indexer *hivev1alpha1.HiveIndexer, ns, name string) error {
	pvc := &corev1.PersistentVolumeClaim{}
	err := r.Get(ctx, client.ObjectKey{Namespace: ns, Name: name}, pvc)
	if err == nil {
		return nil // already exists
	}
	if !errors.IsNotFound(err) {
		return err
	}

	storageQty, err := resource.ParseQuantity(indexer.Spec.StorageSize)
	if err != nil {
		return fmt.Errorf("parse storageSize %q: %w", indexer.Spec.StorageSize, err)
	}

	pvc = &corev1.PersistentVolumeClaim{
		ObjectMeta: metav1.ObjectMeta{
			Namespace: ns,
			Name:      name,
			Labels: map[string]string{
				indexerManagedByLabel: indexerManagedByValue,
			},
		},
		Spec: corev1.PersistentVolumeClaimSpec{
			AccessModes:      []corev1.PersistentVolumeAccessMode{corev1.ReadWriteOnce},
			StorageClassName: &indexer.Spec.StorageClass,
			Resources: corev1.VolumeResourceRequirements{
				Requests: corev1.ResourceList{
					corev1.ResourceStorage: storageQty,
				},
			},
		},
	}
	return r.Create(ctx, pvc)
}

// tenantWorkspacePVCName returns the shared workspace claim name for a company.
// Must match HiveCompany / HiveWorkerPool (workspace-{companyID}), not HiveCompany CR metadata.name.
func tenantWorkspacePVCName(companyID string) string {
	return "workspace-" + companyID
}

// ensureDeployment creates or updates the CocoIndex Deployment.
// Applies the same SecurityContext policy as HiveWorkerPoolReconciler:
// nonroot UID 65534, readOnlyRootFilesystem, drop ALL capabilities.
func (r *HiveIndexerReconciler) ensureDeployment(
	ctx context.Context,
	indexer *hivev1alpha1.HiveIndexer,
	ns, tokenSecretName, pvcName, companyID string,
) error {
	replicas := int32(1)

	// Build environment — secrets injected via secretKeyRef (never plain text)
	envVars := []corev1.EnvVar{
		{
			Name: "COCOINDEX_API_TOKEN",
			ValueFrom: &corev1.EnvVarSource{
				SecretKeyRef: &corev1.SecretKeySelector{
					LocalObjectReference: corev1.LocalObjectReference{Name: tokenSecretName},
					Key:                  "token",
				},
			},
		},
		{Name: "COCOINDEX_REPOS_PATH", Value: "/workspace"},
		{Name: "COCOINDEX_LANCEDB_URI", Value: "/data/lancedb"},
		{Name: "COCOINDEX_EMBEDDING_URL", Value: indexer.Spec.EmbeddingURL},
		{Name: "COCOINDEX_EMBEDDING_DIM", Value: fmt.Sprintf("%d", indexer.Spec.EmbeddingDim)},
		{Name: "COCOINDEX_API_HOST", Value: "0.0.0.0"},
		{Name: "COCOINDEX_API_PORT", Value: "8080"},
	}

	// Inject DragonflyDB password from Secret if configured
	if indexer.Spec.DragonflySecretRef != "" && indexer.Spec.DragonflyURL != "" {
		envVars = append(envVars,
			corev1.EnvVar{
				Name: "DRAGONFLY_PASSWORD",
				ValueFrom: &corev1.EnvVarSource{
					SecretKeyRef: &corev1.SecretKeySelector{
						LocalObjectReference: corev1.LocalObjectReference{Name: indexer.Spec.DragonflySecretRef},
						Key:                  "password",
					},
				},
			},
			corev1.EnvVar{
				// URL uses the password env var substituted at container startup
				Name:  "COCOINDEX_DRAGONFLY_URL",
				Value: indexer.Spec.DragonflyURL,
			},
		)
	}

	// Resource defaults — applied if spec.resources is empty
	resources := indexer.Spec.Resources
	if resources.Requests == nil {
		resources.Requests = corev1.ResourceList{
			corev1.ResourceMemory: resource.MustParse("4Gi"),
			corev1.ResourceCPU:    resource.MustParse("1"),
		}
	}
	if resources.Limits == nil {
		resources.Limits = corev1.ResourceList{
			corev1.ResourceMemory: resource.MustParse("8Gi"),
			corev1.ResourceCPU:    resource.MustParse("4"),
		}
	}

	dep := &appsv1.Deployment{
		ObjectMeta: metav1.ObjectMeta{
			Namespace: ns,
			Name:      indexer.Name,
			Labels: map[string]string{
				indexerManagedByLabel: indexerManagedByValue,
			},
		},
		Spec: appsv1.DeploymentSpec{
			Replicas: &replicas,
			Selector: &metav1.LabelSelector{
				MatchLabels: map[string]string{"app": indexer.Name},
			},
			Template: corev1.PodTemplateSpec{
				ObjectMeta: metav1.ObjectMeta{
					Labels: map[string]string{
						"app":          indexer.Name,
						"hive.io/role": "indexer", // used by NetworkPolicy to restrict direct worker access
					},
					Annotations: map[string]string{
						// Allow Prometheus scraping from within the cluster
						"prometheus.io/scrape": "false", // set to true when /metrics is added
						"prometheus.io/port":   "8080",
					},
				},
				Spec: corev1.PodSpec{
					Containers: []corev1.Container{{
						Name:            "cocoindex",
						Image:           indexer.Spec.IndexerImage,
						ImagePullPolicy: corev1.PullIfNotPresent,
						Ports:           []corev1.ContainerPort{{ContainerPort: 8080, Name: "http"}},
						Env:             envVars,
						Resources:       resources,
						VolumeMounts: []corev1.VolumeMount{
							{Name: "lancedb", MountPath: "/data/lancedb"},
							{Name: "workspace", MountPath: "/workspace", ReadOnly: true},
							// Python needs /tmp even with readOnlyRootFilesystem
							{Name: "tmp", MountPath: "/tmp"},
						},
						LivenessProbe: &corev1.Probe{
							ProbeHandler: corev1.ProbeHandler{
								HTTPGet: &corev1.HTTPGetAction{
									Port: intstr.FromInt(8080),
									Path: "/health",
								},
							},
							PeriodSeconds:    10,
							FailureThreshold: 3,
						},
						ReadinessProbe: &corev1.Probe{
							ProbeHandler: corev1.ProbeHandler{
								HTTPGet: &corev1.HTTPGetAction{
									Port: intstr.FromInt(8080),
									Path: "/health",
								},
							},
							PeriodSeconds:    5,
							FailureThreshold: 1,
						},
						// Security policy mirrors workerpool_controller.go:291-296
						SecurityContext: &corev1.SecurityContext{
							RunAsNonRoot:             boolPtr(true),
							RunAsUser:                int64Ptr(65534),
							ReadOnlyRootFilesystem:   boolPtr(true),
							AllowPrivilegeEscalation: boolPtr(false),
							Capabilities: &corev1.Capabilities{
								Drop: []corev1.Capability{"ALL"},
							},
						},
					}},
					Volumes: []corev1.Volume{
						{
							Name: "lancedb",
							VolumeSource: corev1.VolumeSource{
								PersistentVolumeClaim: &corev1.PersistentVolumeClaimVolumeSource{
									ClaimName: pvcName,
								},
							},
						},
						{
							// Company workspace PVC (read-only — indexer reads code, never writes)
							Name: "workspace",
							VolumeSource: corev1.VolumeSource{
								PersistentVolumeClaim: &corev1.PersistentVolumeClaimVolumeSource{
									ClaimName: tenantWorkspacePVCName(companyID),
									ReadOnly:  true,
								},
							},
						},
						{
							// Writable tmpfs for Python even with readOnlyRootFilesystem
							Name: "tmp",
							VolumeSource: corev1.VolumeSource{
								EmptyDir: &corev1.EmptyDirVolumeSource{},
							},
						},
					},
					NodeSelector: indexer.Spec.NodeSelector,
				},
			},
		},
	}

	// Create or update
	existing := &appsv1.Deployment{}
	if err := r.Get(ctx, client.ObjectKey{Namespace: ns, Name: indexer.Name}, existing); err != nil {
		if errors.IsNotFound(err) {
			return r.Create(ctx, dep)
		}
		return err
	}
	existing.Spec.Template.Spec.Containers[0].Image = indexer.Spec.IndexerImage
	existing.Spec.Template.Spec.Containers[0].Env = envVars
	existing.Spec.Template.Spec.Containers[0].Resources = resources
	return r.Update(ctx, existing)
}

// ensureService creates a ClusterIP Service for the CocoIndex API if absent.
func (r *HiveIndexerReconciler) ensureService(ctx context.Context, indexer *hivev1alpha1.HiveIndexer, ns string) error {
	svc := &corev1.Service{}
	err := r.Get(ctx, client.ObjectKey{Namespace: ns, Name: indexer.Name}, svc)
	if err == nil {
		return nil // already exists
	}
	if !errors.IsNotFound(err) {
		return err
	}

	svc = &corev1.Service{
		ObjectMeta: metav1.ObjectMeta{
			Namespace: ns,
			Name:      indexer.Name,
			Labels: map[string]string{
				indexerManagedByLabel: indexerManagedByValue,
			},
		},
		Spec: corev1.ServiceSpec{
			Selector: map[string]string{"app": indexer.Name},
			Ports: []corev1.ServicePort{{
				Port:       8080,
				TargetPort: intstr.FromInt(8080),
				Name:       "http",
			}},
			Type: corev1.ServiceTypeClusterIP,
		},
	}
	return r.Create(ctx, svc)
}

// ensureWorkerTokenSecret creates a separate worker-tier token Secret used by the MCP gateway.
// Workers receive this token as HIVE_MCP_TOKEN via secretKeyRef.
// It is distinct from the admin token so workers never have full indexer access.
func (r *HiveIndexerReconciler) ensureWorkerTokenSecret(ctx context.Context, ns, name string) error {
	secret := &corev1.Secret{}
	if err := r.Get(ctx, client.ObjectKey{Namespace: ns, Name: name}, secret); err == nil {
		return nil // already exists
	} else if !errors.IsNotFound(err) {
		return err
	}
	tokenBytes := make([]byte, 32)
	if _, err := rand.Read(tokenBytes); err != nil {
		return fmt.Errorf("generate worker token: %w", err)
	}
	secret = &corev1.Secret{
		ObjectMeta: metav1.ObjectMeta{
			Namespace: ns,
			Name:      name,
			Labels:    map[string]string{indexerManagedByLabel: indexerManagedByValue},
		},
		StringData: map[string]string{"token": hex.EncodeToString(tokenBytes)},
	}
	return r.Create(ctx, secret)
}

// ensureGatewayDeployment creates or updates the MCP gateway Deployment.
// The gateway holds both the admin token (to call the indexer) and the worker token
// (to validate incoming HIVE_MCP_TOKEN requests). Workers never see the admin token.
func (r *HiveIndexerReconciler) ensureGatewayDeployment(
	ctx context.Context,
	indexer *hivev1alpha1.HiveIndexer,
	ns, name, adminSecretName, workerSecretName string,
) error {
	replicas := int32(1)
	indexerSvcURL := fmt.Sprintf("http://%s.%s.svc.cluster.local:8080", indexer.Name, ns)

	envVars := []corev1.EnvVar{
		{
			Name: "GATEWAY_ADMIN_TOKEN",
			ValueFrom: &corev1.EnvVarSource{SecretKeyRef: &corev1.SecretKeySelector{
				LocalObjectReference: corev1.LocalObjectReference{Name: adminSecretName},
				Key:                  "token",
			}},
		},
		{
			Name: "GATEWAY_WORKER_TOKEN",
			ValueFrom: &corev1.EnvVarSource{SecretKeyRef: &corev1.SecretKeySelector{
				LocalObjectReference: corev1.LocalObjectReference{Name: workerSecretName},
				Key:                  "token",
			}},
		},
		{Name: "GATEWAY_INDEXER_URL", Value: indexerSvcURL},
	}

	dep := &appsv1.Deployment{
		ObjectMeta: metav1.ObjectMeta{
			Namespace: ns,
			Name:      name,
			Labels:    map[string]string{indexerManagedByLabel: indexerManagedByValue},
		},
		Spec: appsv1.DeploymentSpec{
			Replicas: &replicas,
			Selector: &metav1.LabelSelector{MatchLabels: map[string]string{"app": name}},
			Template: corev1.PodTemplateSpec{
				ObjectMeta: metav1.ObjectMeta{
					Labels: map[string]string{
						"app":          name,
						"hive.io/role": "mcp-gateway", // used by NetworkPolicy to allow gateway→indexer on 8080
					},
				},
				Spec: corev1.PodSpec{
					Containers: []corev1.Container{{
						Name:            "mcp-gateway",
						Image:           indexer.Spec.GatewayImage,
						ImagePullPolicy: corev1.PullIfNotPresent,
						Ports:           []corev1.ContainerPort{{ContainerPort: 9090, Name: "http"}},
						Env:             envVars,
						Resources: corev1.ResourceRequirements{
							Requests: corev1.ResourceList{
								corev1.ResourceMemory: resource.MustParse("64Mi"),
								corev1.ResourceCPU:    resource.MustParse("50m"),
							},
							Limits: corev1.ResourceList{
								corev1.ResourceMemory: resource.MustParse("256Mi"),
								corev1.ResourceCPU:    resource.MustParse("200m"),
							},
						},
						VolumeMounts: []corev1.VolumeMount{{Name: "tmp", MountPath: "/tmp"}},
						LivenessProbe: &corev1.Probe{
							ProbeHandler: corev1.ProbeHandler{HTTPGet: &corev1.HTTPGetAction{
								Port: intstr.FromInt(9090), Path: "/health",
							}},
							PeriodSeconds: 10, FailureThreshold: 3,
						},
						ReadinessProbe: &corev1.Probe{
							ProbeHandler: corev1.ProbeHandler{HTTPGet: &corev1.HTTPGetAction{
								Port: intstr.FromInt(9090), Path: "/health",
							}},
							PeriodSeconds: 5, FailureThreshold: 1,
						},
						SecurityContext: &corev1.SecurityContext{
							RunAsNonRoot:             boolPtr(true),
							RunAsUser:                int64Ptr(65534),
							ReadOnlyRootFilesystem:   boolPtr(true),
							AllowPrivilegeEscalation: boolPtr(false),
							Capabilities:             &corev1.Capabilities{Drop: []corev1.Capability{"ALL"}},
						},
					}},
					Volumes: []corev1.Volume{{
						Name:         "tmp",
						VolumeSource: corev1.VolumeSource{EmptyDir: &corev1.EmptyDirVolumeSource{}},
					}},
				},
			},
		},
	}

	existing := &appsv1.Deployment{}
	if err := r.Get(ctx, client.ObjectKey{Namespace: ns, Name: name}, existing); err != nil {
		if errors.IsNotFound(err) {
			return r.Create(ctx, dep)
		}
		return err
	}
	existing.Spec.Template.Spec.Containers[0].Image = indexer.Spec.GatewayImage
	existing.Spec.Template.Spec.Containers[0].Env = envVars
	return r.Update(ctx, existing)
}

// ensureGatewayService creates a ClusterIP Service for the MCP gateway on port 9090.
func (r *HiveIndexerReconciler) ensureGatewayService(ctx context.Context, ns, name string) error {
	svc := &corev1.Service{}
	if err := r.Get(ctx, client.ObjectKey{Namespace: ns, Name: name}, svc); err == nil {
		return nil
	} else if !errors.IsNotFound(err) {
		return err
	}
	svc = &corev1.Service{
		ObjectMeta: metav1.ObjectMeta{
			Namespace: ns,
			Name:      name,
			Labels:    map[string]string{indexerManagedByLabel: indexerManagedByValue},
		},
		Spec: corev1.ServiceSpec{
			Selector: map[string]string{"app": name},
			Ports: []corev1.ServicePort{{
				Port:       9090,
				TargetPort: intstr.FromInt(9090),
				Name:       "http",
			}},
			Type: corev1.ServiceTypeClusterIP,
		},
	}
	return r.Create(ctx, svc)
}

// SetupWithManager registers the controller with the Manager.
func (r *HiveIndexerReconciler) SetupWithManager(mgr ctrl.Manager) error {
	return ctrl.NewControllerManagedBy(mgr).
		For(&hivev1alpha1.HiveIndexer{}).
		Complete(r)
}

// Note: containsString and removeString are defined in company_controller.go.
