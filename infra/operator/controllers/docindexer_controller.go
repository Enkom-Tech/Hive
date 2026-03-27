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
	docIndexerFinalizer      = "hive.io/docindexer-finalizer"
	docIndexerManagedByLabel = "managed-by"
	docIndexerManagedByValue = "hive-operator"
)

// HiveDocIndexerReconciler reconciles HiveDocIndexer (DocIndex API + parser worker + optional MCP gateway).
type HiveDocIndexerReconciler struct {
	client.Client
	Scheme *runtime.Scheme
}

// +kubebuilder:rbac:groups=hive.io,resources=hivedocindexers,verbs=get;list;watch
// +kubebuilder:rbac:groups=hive.io,resources=hivedocindexers/status,verbs=get;update;patch
// +kubebuilder:rbac:groups=hive.io,resources=hivecompanies,verbs=get;list;watch
// +kubebuilder:rbac:groups="",resources=secrets,verbs=get;list;create;update;patch;delete
// +kubebuilder:rbac:groups="",resources=persistentvolumeclaims,verbs=get;list;create;update;patch
// +kubebuilder:rbac:groups=apps,resources=deployments,verbs=get;list;create;update;patch;delete
// +kubebuilder:rbac:groups="",resources=services,verbs=get;list;create;update;patch;delete

func (r *HiveDocIndexerReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	logger := log.FromContext(ctx)
	di := &hivev1alpha1.HiveDocIndexer{}
	if err := r.Get(ctx, req.NamespacedName, di); err != nil {
		if errors.IsNotFound(err) {
			return ctrl.Result{}, nil
		}
		return ctrl.Result{}, err
	}

	if !di.DeletionTimestamp.IsZero() {
		return r.handleDocIndexerDeletion(ctx, di)
	}

	if !containsString(di.Finalizers, docIndexerFinalizer) {
		di.Finalizers = append(di.Finalizers, docIndexerFinalizer)
		if err := r.Update(ctx, di); err != nil {
			return ctrl.Result{}, err
		}
	}

	company := &hivev1alpha1.HiveCompany{}
	if err := r.Get(ctx, client.ObjectKey{Namespace: req.Namespace, Name: di.Spec.CompanyRef}, company); err != nil {
		if errors.IsNotFound(err) {
			logger.Info("HiveCompany not found, requeueing", "companyRef", di.Spec.CompanyRef)
			return ctrl.Result{RequeueAfter: 15 * time.Second}, nil
		}
		return ctrl.Result{}, err
	}

	tenantNS := "hive-tenant-" + company.Spec.CompanyID

	tokenSecretName := di.Name + "-api-token"
	if di.Spec.TokenSecretRef != "" {
		tokenSecretName = di.Spec.TokenSecretRef
	}
	if err := r.ensureDocTokenSecret(ctx, di, tenantNS, tokenSecretName); err != nil {
		logger.Error(err, "failed to ensure API token secret")
		return ctrl.Result{RequeueAfter: 15 * time.Second}, nil
	}

	jobKeySecret := di.Name + "-job-signing"
	if di.Spec.JobSigningKeySecretRef != "" {
		jobKeySecret = di.Spec.JobSigningKeySecretRef
	}
	if err := r.ensureJobSigningSecret(ctx, di, tenantNS, jobKeySecret); err != nil {
		logger.Error(err, "failed to ensure job signing secret")
		return ctrl.Result{RequeueAfter: 15 * time.Second}, nil
	}

	lancePVC := di.Name + "-lancedb"
	docsPVC := di.Name + "-docs"
	if err := r.ensureDocPVC(ctx, tenantNS, lancePVC, di.Spec.LanceDBStorageSize, di.Spec.LanceDBStorageClass); err != nil {
		logger.Error(err, "failed to ensure LanceDB PVC")
		return ctrl.Result{RequeueAfter: 15 * time.Second}, nil
	}
	if err := r.ensureDocPVC(ctx, tenantNS, docsPVC, di.Spec.DocsStorageSize, di.Spec.DocsStorageClass); err != nil {
		logger.Error(err, "failed to ensure docs PVC")
		return ctrl.Result{RequeueAfter: 15 * time.Second}, nil
	}

	svcURL := fmt.Sprintf("http://%s.%s.svc.cluster.local:8082", di.Name, tenantNS)
	if err := r.ensureDocIndexDeployment(ctx, di, tenantNS, tokenSecretName, jobKeySecret, lancePVC, docsPVC); err != nil {
		logger.Error(err, "failed to ensure DocIndex API deployment")
		return ctrl.Result{RequeueAfter: 15 * time.Second}, nil
	}
	if err := r.ensureDocWorkerDeployment(ctx, di, tenantNS, jobKeySecret, docsPVC); err != nil {
		logger.Error(err, "failed to ensure DocIndex worker deployment")
		return ctrl.Result{RequeueAfter: 15 * time.Second}, nil
	}
	if err := r.ensureDocIndexService(ctx, di, tenantNS); err != nil {
		logger.Error(err, "failed to ensure DocIndex service")
		return ctrl.Result{RequeueAfter: 15 * time.Second}, nil
	}

	var gatewayURL, gatewaySecretName string
	if di.Spec.GatewayImage != "" {
		gatewaySecretName = di.Name + "-worker-token"
		if err := r.ensureDocWorkerTokenSecret(ctx, tenantNS, gatewaySecretName); err != nil {
			logger.Error(err, "failed to ensure gateway worker token")
			return ctrl.Result{RequeueAfter: 15 * time.Second}, nil
		}
		gatewayName := di.Name + "-gateway"
		if err := r.ensureDocGatewayDeployment(ctx, di, tenantNS, gatewayName, tokenSecretName, gatewaySecretName); err != nil {
			logger.Error(err, "failed to ensure doc MCP gateway deployment")
			return ctrl.Result{RequeueAfter: 15 * time.Second}, nil
		}
		if err := r.ensureDocGatewayService(ctx, tenantNS, gatewayName); err != nil {
			logger.Error(err, "failed to ensure doc MCP gateway service")
			return ctrl.Result{RequeueAfter: 15 * time.Second}, nil
		}
		gatewayURL = fmt.Sprintf("http://%s.%s.svc.cluster.local:9090", gatewayName, tenantNS)
	}

	di.Status.TokenSecretName = tokenSecretName
	di.Status.ServiceURL = svcURL
	di.Status.GatewayURL = gatewayURL
	di.Status.GatewaySecretName = gatewaySecretName
	di.Status.LastSyncAt = metav1.Now().Format(time.RFC3339)

	apiDep := &appsv1.Deployment{}
	apiReady := false
	if err := r.Get(ctx, client.ObjectKey{Namespace: tenantNS, Name: di.Name}, apiDep); err == nil {
		apiReady = apiDep.Status.ReadyReplicas > 0
	}
	workerDep := &appsv1.Deployment{}
	workerReady := false
	if err := r.Get(ctx, client.ObjectKey{Namespace: tenantNS, Name: di.Name + "-worker"}, workerDep); err == nil {
		workerReady = workerDep.Status.ReadyReplicas > 0
	}
	dataPlaneReady := apiReady && workerReady
	di.Status.Ready = apiReady

	gatewayReady := true
	if di.Spec.GatewayImage != "" {
		gatewayName := di.Name + "-gateway"
		gwDep := &appsv1.Deployment{}
		if err := r.Get(ctx, client.ObjectKey{Namespace: tenantNS, Name: gatewayName}, gwDep); err != nil {
			gatewayReady = false
		} else {
			gatewayReady = gwDep.Status.ReadyReplicas > 0
		}
	}
	applyIndexerDegradedCondition(&di.Status.Conditions, dataPlaneReady, di.Spec.GatewayImage != "", gatewayReady, di.Generation)

	_ = r.Status().Update(ctx, di)
	return ctrl.Result{RequeueAfter: 60 * time.Second}, nil
}

func (r *HiveDocIndexerReconciler) handleDocIndexerDeletion(ctx context.Context, di *hivev1alpha1.HiveDocIndexer) (ctrl.Result, error) {
	logger := log.FromContext(ctx)
	company := &hivev1alpha1.HiveCompany{}
	if err := r.Get(ctx, client.ObjectKey{Namespace: di.Namespace, Name: di.Spec.CompanyRef}, company); err == nil {
		tenantNS := "hive-tenant-" + company.Spec.CompanyID
		for _, name := range []string{di.Name, di.Name + "-worker"} {
			dep := &appsv1.Deployment{}
			dep.Namespace = tenantNS
			dep.Name = name
			if err := r.Delete(ctx, dep); err != nil && !errors.IsNotFound(err) {
				logger.Error(err, "delete deployment during cleanup", "name", name)
			}
		}
		for _, name := range []string{di.Name, di.Name + "-gateway"} {
			svc := &corev1.Service{}
			svc.Namespace = tenantNS
			svc.Name = name
			if err := r.Delete(ctx, svc); err != nil && !errors.IsNotFound(err) {
				logger.Error(err, "delete service during cleanup", "name", name)
			}
		}
		if di.Spec.TokenSecretRef == "" {
			_ = r.Delete(ctx, &corev1.Secret{ObjectMeta: metav1.ObjectMeta{Namespace: tenantNS, Name: di.Name + "-api-token"}})
		}
		if di.Spec.GatewayImage != "" {
			_ = r.Delete(ctx, &appsv1.Deployment{ObjectMeta: metav1.ObjectMeta{Namespace: tenantNS, Name: di.Name + "-gateway"}})
			_ = r.Delete(ctx, &corev1.Service{ObjectMeta: metav1.ObjectMeta{Namespace: tenantNS, Name: di.Name + "-gateway"}})
			_ = r.Delete(ctx, &corev1.Secret{ObjectMeta: metav1.ObjectMeta{Namespace: tenantNS, Name: di.Name + "-worker-token"}})
		}
		if di.Spec.JobSigningKeySecretRef == "" {
			_ = r.Delete(ctx, &corev1.Secret{ObjectMeta: metav1.ObjectMeta{Namespace: tenantNS, Name: di.Name + "-job-signing"}})
		}
	}
	di.Finalizers = removeString(di.Finalizers, docIndexerFinalizer)
	return ctrl.Result{}, r.Update(ctx, di)
}

func (r *HiveDocIndexerReconciler) ensureDocTokenSecret(ctx context.Context, di *hivev1alpha1.HiveDocIndexer, ns, name string) error {
	if di.Spec.TokenSecretRef != "" {
		return nil
	}
	secret := &corev1.Secret{}
	err := r.Get(ctx, client.ObjectKey{Namespace: ns, Name: name}, secret)
	if err == nil {
		return nil
	}
	if !errors.IsNotFound(err) {
		return err
	}
	tokenBytes := make([]byte, 32)
	if _, err := rand.Read(tokenBytes); err != nil {
		return fmt.Errorf("generate token: %w", err)
	}
	secret = &corev1.Secret{
		ObjectMeta: metav1.ObjectMeta{
			Namespace: ns,
			Name:      name,
			Labels:    map[string]string{docIndexerManagedByLabel: docIndexerManagedByValue},
		},
		StringData: map[string]string{"token": hex.EncodeToString(tokenBytes)},
	}
	return r.Create(ctx, secret)
}

func (r *HiveDocIndexerReconciler) ensureJobSigningSecret(ctx context.Context, di *hivev1alpha1.HiveDocIndexer, ns, name string) error {
	if di.Spec.JobSigningKeySecretRef != "" {
		return nil
	}
	secret := &corev1.Secret{}
	err := r.Get(ctx, client.ObjectKey{Namespace: ns, Name: name}, secret)
	if err == nil {
		return nil
	}
	if !errors.IsNotFound(err) {
		return err
	}
	keyBytes := make([]byte, 32)
	if _, err := rand.Read(keyBytes); err != nil {
		return fmt.Errorf("generate job signing key: %w", err)
	}
	secret = &corev1.Secret{
		ObjectMeta: metav1.ObjectMeta{
			Namespace: ns,
			Name:      name,
			Labels:    map[string]string{docIndexerManagedByLabel: docIndexerManagedByValue},
		},
		StringData: map[string]string{"key": hex.EncodeToString(keyBytes)},
	}
	return r.Create(ctx, secret)
}

func (r *HiveDocIndexerReconciler) ensureDocPVC(ctx context.Context, ns, name, size, storageClass string) error {
	pvc := &corev1.PersistentVolumeClaim{}
	err := r.Get(ctx, client.ObjectKey{Namespace: ns, Name: name}, pvc)
	if err == nil {
		return nil
	}
	if !errors.IsNotFound(err) {
		return err
	}
	qty, err := resource.ParseQuantity(size)
	if err != nil {
		return fmt.Errorf("parse storage %q: %w", size, err)
	}
	sc := storageClass
	pvc = &corev1.PersistentVolumeClaim{
		ObjectMeta: metav1.ObjectMeta{
			Namespace: ns,
			Name:      name,
			Labels:    map[string]string{docIndexerManagedByLabel: docIndexerManagedByValue},
		},
		Spec: corev1.PersistentVolumeClaimSpec{
			AccessModes:      []corev1.PersistentVolumeAccessMode{corev1.ReadWriteOnce},
			StorageClassName: &sc,
			Resources: corev1.VolumeResourceRequirements{
				Requests: corev1.ResourceList{corev1.ResourceStorage: qty},
			},
		},
	}
	return r.Create(ctx, pvc)
}

func docIndexEmbeddingDim(di *hivev1alpha1.HiveDocIndexer) int32 {
	if di.Spec.EmbeddingDim <= 0 {
		return 4096
	}
	return di.Spec.EmbeddingDim
}

func docIndexEnv(di *hivev1alpha1.HiveDocIndexer, tokenSecret, jobKeySecret string) []corev1.EnvVar {
	dim := docIndexEmbeddingDim(di)
	return []corev1.EnvVar{
		{Name: "DOCINDEX_API_TOKEN", ValueFrom: &corev1.EnvVarSource{SecretKeyRef: &corev1.SecretKeySelector{
			LocalObjectReference: corev1.LocalObjectReference{Name: tokenSecret}, Key: "token",
		}}},
		{Name: "DOCINDEX_JOB_SIGNING_KEY", ValueFrom: &corev1.EnvVarSource{SecretKeyRef: &corev1.SecretKeySelector{
			LocalObjectReference: corev1.LocalObjectReference{Name: jobKeySecret}, Key: "key",
		}}},
		{Name: "DOCINDEX_REDIS_URL", ValueFrom: &corev1.EnvVarSource{SecretKeyRef: &corev1.SecretKeySelector{
			LocalObjectReference: corev1.LocalObjectReference{Name: di.Spec.RedisURLSecretRef}, Key: "url",
		}}},
		{Name: "DOCINDEX_EMBEDDING_URL", Value: di.Spec.EmbeddingURL},
		{Name: "DOCINDEX_EMBEDDING_DIM", Value: fmt.Sprintf("%d", dim)},
		{Name: "DOCINDEX_USE_WORKER_QUEUE", Value: "true"},
		{Name: "DOCINDEX_LANCEDB_URI", Value: "/data/lancedb"},
		{Name: "DOCINDEX_DOCS_PATH", Value: "/data/docs"},
		{Name: "DOCINDEX_API_HOST", Value: "0.0.0.0"},
		{Name: "DOCINDEX_API_PORT", Value: "8082"},
	}
}

func docWorkerEnv(di *hivev1alpha1.HiveDocIndexer, jobKeySecret string) []corev1.EnvVar {
	dim := docIndexEmbeddingDim(di)
	return []corev1.EnvVar{
		{Name: "DOCINDEX_JOB_SIGNING_KEY", ValueFrom: &corev1.EnvVarSource{SecretKeyRef: &corev1.SecretKeySelector{
			LocalObjectReference: corev1.LocalObjectReference{Name: jobKeySecret}, Key: "key",
		}}},
		{Name: "DOCINDEX_REDIS_URL", ValueFrom: &corev1.EnvVarSource{SecretKeyRef: &corev1.SecretKeySelector{
			LocalObjectReference: corev1.LocalObjectReference{Name: di.Spec.RedisURLSecretRef}, Key: "url",
		}}},
		{Name: "DOCINDEX_EMBEDDING_URL", Value: di.Spec.EmbeddingURL},
		{Name: "DOCINDEX_EMBEDDING_DIM", Value: fmt.Sprintf("%d", dim)},
		{Name: "DOCINDEX_DOCS_PATH", Value: "/data/docs"},
	}
}

func (r *HiveDocIndexerReconciler) ensureDocIndexDeployment(
	ctx context.Context, di *hivev1alpha1.HiveDocIndexer, ns, tokenSecret, jobKeySecret, lancePVC, docsPVC string,
) error {
	replicas := int32(1)
	envVars := docIndexEnv(di, tokenSecret, jobKeySecret)
	resources := di.Spec.Resources
	if resources.Requests == nil {
		resources.Requests = corev1.ResourceList{
			corev1.ResourceMemory: resource.MustParse("512Mi"),
			corev1.ResourceCPU:    resource.MustParse("250m"),
		}
	}
	if resources.Limits == nil {
		resources.Limits = corev1.ResourceList{
			corev1.ResourceMemory: resource.MustParse("2Gi"),
			corev1.ResourceCPU:    resource.MustParse("2"),
		}
	}

	dep := &appsv1.Deployment{
		ObjectMeta: metav1.ObjectMeta{
			Namespace: ns,
			Name:      di.Name,
			Labels:    map[string]string{docIndexerManagedByLabel: docIndexerManagedByValue},
		},
		Spec: appsv1.DeploymentSpec{
			Replicas: &replicas,
			Selector: &metav1.LabelSelector{MatchLabels: map[string]string{"app": di.Name}},
			Template: corev1.PodTemplateSpec{
				ObjectMeta: metav1.ObjectMeta{
					Labels: map[string]string{
						"app":          di.Name,
						"hive.io/role": "indexer",
					},
				},
				Spec: corev1.PodSpec{
					Containers: []corev1.Container{{
						Name:            "docindex",
						Image:           di.Spec.DocIndexImage,
						ImagePullPolicy: corev1.PullIfNotPresent,
						Ports:           []corev1.ContainerPort{{ContainerPort: 8082, Name: "http"}},
						Env:             envVars,
						Resources:       resources,
						VolumeMounts: []corev1.VolumeMount{
							{Name: "lancedb", MountPath: "/data/lancedb"},
							{Name: "docs", MountPath: "/data/docs"},
							{Name: "tmp", MountPath: "/tmp"},
						},
						LivenessProbe: &corev1.Probe{
							ProbeHandler: corev1.ProbeHandler{HTTPGet: &corev1.HTTPGetAction{
								Port: intstr.FromInt(8082), Path: "/health",
							}},
							PeriodSeconds: 10, FailureThreshold: 3,
						},
						ReadinessProbe: &corev1.Probe{
							ProbeHandler: corev1.ProbeHandler{HTTPGet: &corev1.HTTPGetAction{
								Port: intstr.FromInt(8082), Path: "/health",
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
					Volumes: []corev1.Volume{
						{Name: "lancedb", VolumeSource: corev1.VolumeSource{PersistentVolumeClaim: &corev1.PersistentVolumeClaimVolumeSource{ClaimName: lancePVC}}},
						{Name: "docs", VolumeSource: corev1.VolumeSource{PersistentVolumeClaim: &corev1.PersistentVolumeClaimVolumeSource{ClaimName: docsPVC}}},
						{Name: "tmp", VolumeSource: corev1.VolumeSource{EmptyDir: &corev1.EmptyDirVolumeSource{}}},
					},
					NodeSelector: di.Spec.NodeSelector,
				},
			},
		},
	}

	existing := &appsv1.Deployment{}
	if err := r.Get(ctx, client.ObjectKey{Namespace: ns, Name: di.Name}, existing); err != nil {
		if errors.IsNotFound(err) {
			return r.Create(ctx, dep)
		}
		return err
	}
	existing.Spec.Template.Spec.Containers[0].Image = di.Spec.DocIndexImage
	existing.Spec.Template.Spec.Containers[0].Env = envVars
	existing.Spec.Template.Spec.Containers[0].Resources = resources
	return r.Update(ctx, existing)
}

func (r *HiveDocIndexerReconciler) ensureDocWorkerDeployment(
	ctx context.Context, di *hivev1alpha1.HiveDocIndexer, ns, jobKeySecret, docsPVC string,
) error {
	replicas := int32(1)
	name := di.Name + "-worker"
	envVars := docWorkerEnv(di, jobKeySecret)
	resources := di.Spec.WorkerResources
	if resources.Requests == nil {
		resources.Requests = corev1.ResourceList{
			corev1.ResourceMemory: resource.MustParse("2Gi"),
			corev1.ResourceCPU:    resource.MustParse("500m"),
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
			Name:      name,
			Labels:    map[string]string{docIndexerManagedByLabel: docIndexerManagedByValue},
		},
		Spec: appsv1.DeploymentSpec{
			Replicas: &replicas,
			Selector: &metav1.LabelSelector{MatchLabels: map[string]string{"app": name}},
			Template: corev1.PodTemplateSpec{
				ObjectMeta: metav1.ObjectMeta{Labels: map[string]string{"app": name}},
				Spec: corev1.PodSpec{
					Containers: []corev1.Container{{
						Name:            "docindex-worker",
						Image:           di.Spec.ParserWorkerImage,
						ImagePullPolicy: corev1.PullIfNotPresent,
						Env:             envVars,
						Resources:       resources,
						VolumeMounts: []corev1.VolumeMount{
							{Name: "docs", MountPath: "/data/docs"},
							{Name: "tmp", MountPath: "/tmp"},
						},
						SecurityContext: &corev1.SecurityContext{
							RunAsNonRoot:             boolPtr(true),
							RunAsUser:                int64Ptr(65534),
							ReadOnlyRootFilesystem:   boolPtr(true),
							AllowPrivilegeEscalation: boolPtr(false),
							Capabilities:             &corev1.Capabilities{Drop: []corev1.Capability{"ALL"}},
						},
					}},
					Volumes: []corev1.Volume{
						{Name: "docs", VolumeSource: corev1.VolumeSource{PersistentVolumeClaim: &corev1.PersistentVolumeClaimVolumeSource{ClaimName: docsPVC}}},
						{Name: "tmp", VolumeSource: corev1.VolumeSource{EmptyDir: &corev1.EmptyDirVolumeSource{}}},
					},
					NodeSelector: di.Spec.NodeSelector,
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
	existing.Spec.Template.Spec.Containers[0].Image = di.Spec.ParserWorkerImage
	existing.Spec.Template.Spec.Containers[0].Env = envVars
	existing.Spec.Template.Spec.Containers[0].Resources = resources
	return r.Update(ctx, existing)
}

func (r *HiveDocIndexerReconciler) ensureDocIndexService(ctx context.Context, di *hivev1alpha1.HiveDocIndexer, ns string) error {
	svc := &corev1.Service{}
	if err := r.Get(ctx, client.ObjectKey{Namespace: ns, Name: di.Name}, svc); err == nil {
		return nil
	} else if !errors.IsNotFound(err) {
		return err
	}
	svc = &corev1.Service{
		ObjectMeta: metav1.ObjectMeta{
			Namespace: ns,
			Name:      di.Name,
			Labels:    map[string]string{docIndexerManagedByLabel: docIndexerManagedByValue},
		},
		Spec: corev1.ServiceSpec{
			Selector: map[string]string{"app": di.Name},
			Ports: []corev1.ServicePort{{
				Port: 8082, TargetPort: intstr.FromInt(8082), Name: "http",
			}},
			Type: corev1.ServiceTypeClusterIP,
		},
	}
	return r.Create(ctx, svc)
}

func (r *HiveDocIndexerReconciler) ensureDocWorkerTokenSecret(ctx context.Context, ns, name string) error {
	secret := &corev1.Secret{}
	err := r.Get(ctx, client.ObjectKey{Namespace: ns, Name: name}, secret)
	if err == nil {
		return nil
	}
	if !errors.IsNotFound(err) {
		return err
	}
	tokenBytes := make([]byte, 32)
	if _, err := rand.Read(tokenBytes); err != nil {
		return err
	}
	secret = &corev1.Secret{
		ObjectMeta: metav1.ObjectMeta{Namespace: ns, Name: name, Labels: map[string]string{docIndexerManagedByLabel: docIndexerManagedByValue}},
		StringData: map[string]string{"token": hex.EncodeToString(tokenBytes)},
	}
	return r.Create(ctx, secret)
}

func (r *HiveDocIndexerReconciler) ensureDocGatewayDeployment(
	ctx context.Context, di *hivev1alpha1.HiveDocIndexer, ns, name, adminSecret, workerSecret string,
) error {
	replicas := int32(1)
	indexerURL := fmt.Sprintf("http://%s.%s.svc.cluster.local:8082", di.Name, ns)
	envVars := []corev1.EnvVar{
		{Name: "GATEWAY_ADMIN_TOKEN", ValueFrom: &corev1.EnvVarSource{SecretKeyRef: &corev1.SecretKeySelector{
			LocalObjectReference: corev1.LocalObjectReference{Name: adminSecret}, Key: "token",
		}}},
		{Name: "GATEWAY_WORKER_TOKEN", ValueFrom: &corev1.EnvVarSource{SecretKeyRef: &corev1.SecretKeySelector{
			LocalObjectReference: corev1.LocalObjectReference{Name: workerSecret}, Key: "token",
		}}},
		{Name: "GATEWAY_INDEXER_URL", Value: indexerURL},
		{Name: "GATEWAY_DOCINDEX_MODE", Value: "1"},
	}

	dep := &appsv1.Deployment{
		ObjectMeta: metav1.ObjectMeta{Namespace: ns, Name: name, Labels: map[string]string{docIndexerManagedByLabel: docIndexerManagedByValue}},
		Spec: appsv1.DeploymentSpec{
			Replicas: &replicas,
			Selector: &metav1.LabelSelector{MatchLabels: map[string]string{"app": name}},
			Template: corev1.PodTemplateSpec{
				ObjectMeta: metav1.ObjectMeta{Labels: map[string]string{"app": name, "hive.io/role": "mcp-gateway"}},
				Spec: corev1.PodSpec{
					Containers: []corev1.Container{{
						Name: "mcp-gateway", Image: di.Spec.GatewayImage, ImagePullPolicy: corev1.PullIfNotPresent,
						Ports: []corev1.ContainerPort{{ContainerPort: 9090, Name: "http"}},
						Env:   envVars,
						Resources: corev1.ResourceRequirements{
							Requests: corev1.ResourceList{corev1.ResourceMemory: resource.MustParse("64Mi"), corev1.ResourceCPU: resource.MustParse("50m")},
							Limits:   corev1.ResourceList{corev1.ResourceMemory: resource.MustParse("256Mi"), corev1.ResourceCPU: resource.MustParse("200m")},
						},
						VolumeMounts: []corev1.VolumeMount{{Name: "tmp", MountPath: "/tmp"}},
						LivenessProbe: &corev1.Probe{ProbeHandler: corev1.ProbeHandler{HTTPGet: &corev1.HTTPGetAction{
							Port: intstr.FromInt(9090), Path: "/health",
						}}, PeriodSeconds: 10, FailureThreshold: 3},
						ReadinessProbe: &corev1.Probe{ProbeHandler: corev1.ProbeHandler{HTTPGet: &corev1.HTTPGetAction{
							Port: intstr.FromInt(9090), Path: "/health",
						}}, PeriodSeconds: 5, FailureThreshold: 1},
						SecurityContext: &corev1.SecurityContext{
							RunAsNonRoot: boolPtr(true), RunAsUser: int64Ptr(65534), ReadOnlyRootFilesystem: boolPtr(true),
							AllowPrivilegeEscalation: boolPtr(false), Capabilities: &corev1.Capabilities{Drop: []corev1.Capability{"ALL"}},
						},
					}},
					Volumes: []corev1.Volume{{Name: "tmp", VolumeSource: corev1.VolumeSource{EmptyDir: &corev1.EmptyDirVolumeSource{}}}},
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
	existing.Spec.Template.Spec.Containers[0].Image = di.Spec.GatewayImage
	existing.Spec.Template.Spec.Containers[0].Env = envVars
	return r.Update(ctx, existing)
}

func (r *HiveDocIndexerReconciler) ensureDocGatewayService(ctx context.Context, ns, name string) error {
	svc := &corev1.Service{}
	if err := r.Get(ctx, client.ObjectKey{Namespace: ns, Name: name}, svc); err == nil {
		return nil
	} else if !errors.IsNotFound(err) {
		return err
	}
	svc = &corev1.Service{
		ObjectMeta: metav1.ObjectMeta{Namespace: ns, Name: name, Labels: map[string]string{docIndexerManagedByLabel: docIndexerManagedByValue}},
		Spec: corev1.ServiceSpec{
			Selector: map[string]string{"app": name},
			Ports:    []corev1.ServicePort{{Port: 9090, TargetPort: intstr.FromInt(9090), Name: "http"}},
			Type:     corev1.ServiceTypeClusterIP,
		},
	}
	return r.Create(ctx, svc)
}

// SetupWithManager registers the controller.
func (r *HiveDocIndexerReconciler) SetupWithManager(mgr ctrl.Manager) error {
	return ctrl.NewControllerManagedBy(mgr).
		For(&hivev1alpha1.HiveDocIndexer{}).
		Complete(r)
}
