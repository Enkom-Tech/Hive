package controllers

import (
	"context"
	"fmt"
	"math"
	"strings"
	"time"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/util/intstr"
	"k8s.io/apimachinery/pkg/types"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/handler"
	"sigs.k8s.io/controller-runtime/pkg/log"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"

	hivev1alpha1 "github.com/Enkom-Tech/hive-operator/api/v1alpha1"
	"github.com/Enkom-Tech/hive-operator/internal/controlplane"
)

const (
	managedByLabel = "managed-by"
	managedByValue = "hive-operator"
	poolNameLabel  = "hive.io/pool-name"
	finalizerName  = "hive.io/finalizer"
)

// workerImagePullPolicy returns PullIfNotPresent for digest-pinned images, PullAlways for mutable tags.
func workerImagePullPolicy(workerImage string) corev1.PullPolicy {
	if strings.Contains(workerImage, "@sha256:") {
		return corev1.PullIfNotPresent
	}
	return corev1.PullAlways
}

// HiveWorkerPoolReconciler reconciles a HiveWorkerPool object.
type HiveWorkerPoolReconciler struct {
	client.Client
	Scheme *runtime.Scheme
}

// +kubebuilder:rbac:groups=hive.io,resources=hiveworkerpools,verbs=get;list;watch
// +kubebuilder:rbac:groups=hive.io,resources=hiveworkerpools/status,verbs=get;update;patch
// +kubebuilder:rbac:groups=hive.io,resources=hivecompanies,verbs=get;list;watch
// +kubebuilder:rbac:groups=hive.io,resources=hiveclusters,verbs=get;list;watch
// +kubebuilder:rbac:groups=hive.io,resources=hiveindexers,verbs=get;list;watch
// +kubebuilder:rbac:groups=hive.io,resources=hiveindexers/status,verbs=get
// +kubebuilder:rbac:groups="",resources=secrets,verbs=get;list;create;update;patch;delete
// +kubebuilder:rbac:groups=apps,resources=deployments,verbs=get;list;create;update;patch;delete
// +kubebuilder:rbac:groups="",resources=services,verbs=get;list;create;update;patch;delete
// +kubebuilder:rbac:groups="",resources=namespaces,verbs=get;list

// Reconcile syncs agents with the control plane API and manages Deployment + Service + Secrets.
func (r *HiveWorkerPoolReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	logger := log.FromContext(ctx)
	pool := &hivev1alpha1.HiveWorkerPool{}
	if err := r.Get(ctx, req.NamespacedName, pool); err != nil {
		if errors.IsNotFound(err) {
			return ctrl.Result{}, nil
		}
		return ctrl.Result{}, err
	}

	company := &hivev1alpha1.HiveCompany{}
	if err := r.Get(ctx, client.ObjectKey{Namespace: req.Namespace, Name: pool.Spec.CompanyRef}, company); err != nil {
		if errors.IsNotFound(err) {
			logger.Info("HiveCompany not found", "companyRef", pool.Spec.CompanyRef)
			return ctrl.Result{RequeueAfter: 10 * time.Second}, nil
		}
		return ctrl.Result{}, err
	}

	clusterList := &hivev1alpha1.HiveClusterList{}
	if err := r.List(ctx, clusterList); err != nil {
		return ctrl.Result{}, err
	}
	if len(clusterList.Items) == 0 {
		logger.Info("no HiveCluster found")
		return ctrl.Result{RequeueAfter: 30 * time.Second}, nil
	}
	cluster := &clusterList.Items[0]

	secret := &corev1.Secret{}
	if err := r.Get(ctx, client.ObjectKey{Namespace: req.Namespace, Name: cluster.Spec.ProvisionerSecret}, secret); err != nil {
		if errors.IsNotFound(err) {
			logger.Info("provisioner secret not found", "secret", cluster.Spec.ProvisionerSecret)
			return ctrl.Result{RequeueAfter: 30 * time.Second}, nil
		}
		return ctrl.Result{}, err
	}
	tokenBytes := secret.Data["token"]
	if len(tokenBytes) == 0 {
		tokenBytes = secret.Data["apiKey"]
	}
	if len(tokenBytes) == 0 {
		logger.Info("provisioner secret missing token or apiKey key")
		return ctrl.Result{RequeueAfter: 30 * time.Second}, nil
	}
	token := string(tokenBytes)

	cp := controlplane.NewClient(cluster.Spec.ControlPlaneURL, token)
	companyID := company.Spec.CompanyID
	tenantNS := "hive-tenant-" + companyID
	svcURL := fmt.Sprintf("http://%s.%s.svc.cluster.local:8080/run", pool.Name, tenantNS)

	agents, err := cp.ListAgents(ctx, companyID)
	if err != nil {
		logger.Error(err, "list agents failed")
		return ctrl.Result{RequeueAfter: 30 * time.Second}, nil
	}

	var managed []controlplane.Agent
	for _, a := range agents {
		if a.Metadata != nil && a.Metadata[managedByLabel] == managedByValue && a.Metadata[poolNameLabel] == pool.Name {
			managed = append(managed, a)
		}
	}

	desired := pool.Spec.Replicas
	if desired < 0 {
		desired = 0
	}
	if desired > 50 {
		desired = 50
	}

	if desired == 0 {
		dep := &appsv1.Deployment{}
		if err := r.Get(ctx, client.ObjectKey{Namespace: tenantNS, Name: pool.Name}, dep); err == nil {
			_ = r.Delete(ctx, dep)
		}
		svc := &corev1.Service{}
		if err := r.Get(ctx, client.ObjectKey{Namespace: tenantNS, Name: pool.Name}, svc); err == nil {
			_ = r.Delete(ctx, svc)
		}
		pool.Status.ReadyReplicas = 0
		pool.Status.HealthyAgents = 0
		pool.Status.SyncedAgentIDs = nil
		pool.Status.LastSyncAt = metav1.Now().Format(time.RFC3339)
		_ = r.Status().Update(ctx, pool)
		return ctrl.Result{}, nil
	}

	// Scale down: pause excess agents and delete their secrets
	for i := int(desired); i < len(managed); i++ {
		agentID := managed[i].ID
		if err := cp.PauseAgent(ctx, agentID); err != nil {
			logger.Error(err, "pause agent failed", "agentId", agentID)
		}
		secretName := agentSecretName(pool.Name, i)
		agentSecret := &corev1.Secret{}
		agentSecret.Namespace = tenantNS
		agentSecret.Name = secretName
		if err := r.Delete(ctx, agentSecret); err != nil && !errors.IsNotFound(err) {
			logger.Error(err, "delete agent secret failed", "secret", secretName)
		}
	}
	if len(managed) > int(desired) {
		managed = managed[:desired]
	}

	// Scale up: create agents, keys, secrets, patch adapter config
	for i := len(managed); i < int(desired); i++ {
		agentName := fmt.Sprintf("hive-worker-%s-%d", pool.Name, i)
		meta := map[string]string{
			managedByLabel: managedByValue,
			poolNameLabel:  pool.Name,
		}
		createReq := controlplane.CreateAgentRequest{
			Name:          agentName,
			AdapterType:   "http",
			AdapterConfig: map[string]interface{}{"url": svcURL},
			Metadata:      meta,
		}
		agent, err := cp.CreateAgent(ctx, companyID, createReq)
		if err != nil {
			logger.Error(err, "create agent failed", "name", agentName)
			return ctrl.Result{RequeueAfter: 15 * time.Second}, nil
		}
		key, err := cp.CreateAgentKey(ctx, agent.ID)
		if err != nil {
			logger.Error(err, "create agent key failed", "agentId", agent.ID)
			return ctrl.Result{RequeueAfter: 15 * time.Second}, nil
		}
		if err := cp.PatchAgent(ctx, agent.ID, map[string]interface{}{
			"adapterConfig": map[string]interface{}{"url": svcURL},
		}); err != nil {
			logger.Error(err, "patch agent adapter config failed", "agentId", agent.ID)
		}

		agentSecret := &corev1.Secret{
			ObjectMeta: metav1.ObjectMeta{Namespace: tenantNS, Name: agentSecretName(pool.Name, i)},
			StringData: map[string]string{
				"agentId": agent.ID,
				"key":     key.Key,
			},
		}
		if err := r.Create(ctx, agentSecret); err != nil && !errors.IsAlreadyExists(err) {
			logger.Error(err, "create agent secret failed")
			return ctrl.Result{RequeueAfter: 15 * time.Second}, nil
		}
		managed = append(managed, *agent)
	}

	// Ensure tenant namespace exists (Company controller may have created it)
	ns := &corev1.Namespace{}
	ns.Name = tenantNS
	if err := r.Get(ctx, client.ObjectKey{Name: tenantNS}, ns); err != nil {
		if errors.IsNotFound(err) {
			if err := r.Create(ctx, ns); err != nil {
				logger.Error(err, "create tenant namespace failed")
				return ctrl.Result{RequeueAfter: 10 * time.Second}, nil
			}
		} else {
			return ctrl.Result{}, err
		}
	}

	// Build env: single replica uses one secret; multi-replica uses combined secret + POD_NAME (StatefulSet).
	envVars := []corev1.EnvVar{
		{Name: "HIVE_CONTROL_PLANE_URL", Value: cluster.Spec.ControlPlaneURL},
	}
	if pool.Spec.ModelGatewayURL != "" {
		envVars = append(envVars, corev1.EnvVar{Name: "HIVE_MODEL_GATEWAY_URL", Value: pool.Spec.ModelGatewayURL})
	}
	if desired == 1 {
		envVars = append(envVars,
			corev1.EnvVar{Name: "HIVE_AGENT_ID", ValueFrom: &corev1.EnvVarSource{
				SecretKeyRef: &corev1.SecretKeySelector{LocalObjectReference: corev1.LocalObjectReference{Name: agentSecretName(pool.Name, 0)}, Key: "agentId"},
			}},
			corev1.EnvVar{Name: "HIVE_AGENT_KEY", ValueFrom: &corev1.EnvVarSource{
				SecretKeyRef: &corev1.SecretKeySelector{LocalObjectReference: corev1.LocalObjectReference{Name: agentSecretName(pool.Name, 0)}, Key: "key"},
			}},
		)
	} else {
		combinedSecretName := pool.Name + "-keys"
		combinedSecret := &corev1.Secret{
			ObjectMeta: metav1.ObjectMeta{Namespace: tenantNS, Name: combinedSecretName},
			StringData: make(map[string]string),
		}
		for i := 0; i < int(desired); i++ {
			agentSecret := &corev1.Secret{}
			if err := r.Get(ctx, client.ObjectKey{Namespace: tenantNS, Name: agentSecretName(pool.Name, i)}, agentSecret); err != nil {
				return ctrl.Result{RequeueAfter: 5 * time.Second}, nil
			}
			combinedSecret.StringData[fmt.Sprintf("%d_agentId", i)] = string(agentSecret.Data["agentId"])
			combinedSecret.StringData[fmt.Sprintf("%d_key", i)] = string(agentSecret.Data["key"])
		}
		if err := r.Create(ctx, combinedSecret); err != nil {
			if errors.IsAlreadyExists(err) {
				if err := r.Get(ctx, client.ObjectKey{Namespace: tenantNS, Name: combinedSecretName}, combinedSecret); err == nil {
					for i := 0; i < int(desired); i++ {
						agentSecret := &corev1.Secret{}
						if r.Get(ctx, client.ObjectKey{Namespace: tenantNS, Name: agentSecretName(pool.Name, i)}, agentSecret) == nil {
							combinedSecret.StringData[fmt.Sprintf("%d_agentId", i)] = string(agentSecret.Data["agentId"])
							combinedSecret.StringData[fmt.Sprintf("%d_key", i)] = string(agentSecret.Data["key"])
						}
					}
					_ = r.Update(ctx, combinedSecret)
				}
			}
		}
		envVars = append(envVars,
			corev1.EnvVar{Name: "HIVE_KEYS_SECRET", Value: combinedSecretName},
			corev1.EnvVar{Name: "HIVE_POD_NAME", ValueFrom: &corev1.EnvVarSource{FieldRef: &corev1.ObjectFieldSelector{FieldPath: "metadata.name"}}},
		)
	}

	// Inject MCP gateway credentials if a ready HiveIndexer with a gateway exists for this company.
	// COCOINDEX_API_TOKEN (admin) is NEVER injected here — workers receive only HIVE_MCP_TOKEN.
	indexerList := &hivev1alpha1.HiveIndexerList{}
	if err := r.List(ctx, indexerList, client.InNamespace(req.Namespace)); err == nil {
		for i := range indexerList.Items {
			idx := &indexerList.Items[i]
			if idx.Spec.CompanyRef == pool.Spec.CompanyRef &&
				idx.Status.Ready &&
				idx.Status.GatewayURL != "" &&
				idx.Status.GatewaySecretName != "" {
				envVars = append(envVars,
					corev1.EnvVar{
						Name:  "HIVE_MCP_URL",
						Value: idx.Status.GatewayURL + "/mcp",
					},
					corev1.EnvVar{
						Name: "HIVE_MCP_TOKEN",
						ValueFrom: &corev1.EnvVarSource{
							SecretKeyRef: &corev1.SecretKeySelector{
								LocalObjectReference: corev1.LocalObjectReference{
									Name: idx.Status.GatewaySecretName,
								},
								Key: "token",
							},
						},
					},
				)
				break
			}
		}
	}

	pvcName := "workspace-" + company.Spec.CompanyID
	workerPullPolicy := workerImagePullPolicy(pool.Spec.WorkerImage)
	dep := &appsv1.Deployment{
		ObjectMeta: metav1.ObjectMeta{Namespace: tenantNS, Name: pool.Name},
		Spec: appsv1.DeploymentSpec{
			Replicas: &desired,
			Selector: &metav1.LabelSelector{MatchLabels: map[string]string{"app": pool.Name}},
			Template: corev1.PodTemplateSpec{
				ObjectMeta: metav1.ObjectMeta{Labels: map[string]string{
					"app":          pool.Name,
					"hive.io/role": "worker", // used by NetworkPolicy to allow worker→gateway on 9090
				}},
				Spec: corev1.PodSpec{
					Containers: []corev1.Container{{
						Name:            "worker",
						Image:           pool.Spec.WorkerImage,
						ImagePullPolicy: workerPullPolicy,
						Ports:           []corev1.ContainerPort{{ContainerPort: 8080, Name: "http"}},
						Env:             envVars,
						VolumeMounts: []corev1.VolumeMount{
							{Name: "workspace", MountPath: "/workspace"},
						},
						LivenessProbe:  &corev1.Probe{ProbeHandler: corev1.ProbeHandler{HTTPGet: &corev1.HTTPGetAction{Port: intstr.FromInt(8080), Path: "/health"}}, PeriodSeconds: 10, FailureThreshold: 3},
						ReadinessProbe: &corev1.Probe{ProbeHandler: corev1.ProbeHandler{HTTPGet: &corev1.HTTPGetAction{Port: intstr.FromInt(8080), Path: "/health"}}, PeriodSeconds: 5, FailureThreshold: 1},
						SecurityContext: &corev1.SecurityContext{
							RunAsNonRoot:             boolPtr(true),
							RunAsUser:                int64Ptr(65534),
							ReadOnlyRootFilesystem:   boolPtr(true),
							AllowPrivilegeEscalation: boolPtr(false),
							Capabilities:             &corev1.Capabilities{Drop: []corev1.Capability{"ALL"}},
						},
						Resources: pool.Spec.Resources,
					}},
					Volumes: []corev1.Volume{{
						Name: "workspace",
						VolumeSource: corev1.VolumeSource{
							PersistentVolumeClaim: &corev1.PersistentVolumeClaimVolumeSource{ClaimName: pvcName},
						},
					}},
					NodeSelector: pool.Spec.NodeSelector,
					Tolerations:  pool.Spec.Tolerations,
				},
			},
		},
	}
	// Do not set controller reference: pool is in hive-system, resources are in tenantNS (cross-namespace not allowed).
	if err := r.Create(ctx, dep); err != nil {
		if errors.IsAlreadyExists(err) {
			existing := &appsv1.Deployment{}
			if r.Get(ctx, client.ObjectKey{Namespace: tenantNS, Name: pool.Name}, existing) == nil {
				existing.Spec.Replicas = &desired
				existing.Spec.Template.Spec.Containers[0].Image = pool.Spec.WorkerImage
				existing.Spec.Template.Spec.Containers[0].ImagePullPolicy = workerPullPolicy
				existing.Spec.Template.Spec.Containers[0].Env = envVars
				_ = r.Update(ctx, existing)
			}
		} else {
			return ctrl.Result{}, err
		}
	}

	svc := &corev1.Service{
		ObjectMeta: metav1.ObjectMeta{Namespace: tenantNS, Name: pool.Name},
		Spec: corev1.ServiceSpec{
			Selector: map[string]string{"app": pool.Name},
			Ports:    []corev1.ServicePort{{Port: 8080, TargetPort: intstr.FromInt(8080), Name: "http"}},
		},
	}
	if err := r.Create(ctx, svc); err != nil && !errors.IsAlreadyExists(err) {
		return ctrl.Result{}, err
	}
	if err := r.Get(ctx, client.ObjectKey{Namespace: tenantNS, Name: pool.Name}, dep); err == nil {
		pool.Status.ReadyReplicas = dep.Status.ReadyReplicas
	}
	var healthyAgents int32
	if n := len(managed); n <= math.MaxInt32 {
		healthyAgents = int32(n)
	} else {
		healthyAgents = math.MaxInt32
	}
	pool.Status.HealthyAgents = healthyAgents
	pool.Status.LastSyncAt = metav1.Now().Format(time.RFC3339)
	var agentIDs []string
	for _, a := range managed {
		agentIDs = append(agentIDs, a.ID)
	}
	pool.Status.SyncedAgentIDs = agentIDs
	_ = r.Status().Update(ctx, pool)
	return ctrl.Result{RequeueAfter: 60 * time.Second}, nil
}

// SetupWithManager sets up the controller with the Manager.
// Watches HiveIndexer so that when an indexer becomes ready (or its gateway URL changes),
// all WorkerPools for the same company are reconciled and receive the updated MCP credentials.
func (r *HiveWorkerPoolReconciler) SetupWithManager(mgr ctrl.Manager) error {
	return ctrl.NewControllerManagedBy(mgr).
		For(&hivev1alpha1.HiveWorkerPool{}).
		Watches(
			&hivev1alpha1.HiveIndexer{},
			handler.EnqueueRequestsFromMapFunc(func(ctx context.Context, obj client.Object) []reconcile.Request {
				indexer, ok := obj.(*hivev1alpha1.HiveIndexer)
				if !ok {
					return nil
				}
				poolList := &hivev1alpha1.HiveWorkerPoolList{}
				if err := r.List(ctx, poolList, client.InNamespace(indexer.Namespace)); err != nil {
					return nil
				}
				var requests []reconcile.Request
				for _, pool := range poolList.Items {
					if pool.Spec.CompanyRef == indexer.Spec.CompanyRef {
						requests = append(requests, reconcile.Request{
							NamespacedName: types.NamespacedName{
								Namespace: pool.Namespace,
								Name:      pool.Name,
							},
						})
					}
				}
				return requests
			}),
		).
		Complete(r)
}
