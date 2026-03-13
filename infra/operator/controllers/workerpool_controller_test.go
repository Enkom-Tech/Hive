package controllers

import (
	"context"
	"time"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"
	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	logf "sigs.k8s.io/controller-runtime/pkg/log"
	"sigs.k8s.io/controller-runtime/pkg/log/zap"

	hivev1alpha1 "github.com/enkom/hive-operator/api/v1alpha1"
	"github.com/enkom/hive-operator/internal/testutil"
)

var _ = Describe("WorkerPool controller", func() {
	var stopCh chan struct{}
	var mock *testutil.MockControlPlane

	BeforeEach(func() {
		logf.SetLogger(zap.New(zap.WriteTo(GinkgoWriter), zap.UseDevMode(true)))
		stopCh = make(chan struct{})
		mock = testutil.NewMockControlPlane()
	})

	AfterEach(func() {
		if stopCh != nil {
			close(stopCh)
		}
		if mock != nil {
			_ = mock.Close()
		}
	})

	It("creates Deployment and Service when HiveWorkerPool is created", func() {
		baseURL, err := mock.Start()
		Expect(err).NotTo(HaveOccurred())
		defer mock.Close()

		// Start manager
		mgr, err := ctrl.NewManager(cfg, ctrl.Options{
			Scheme:             testScheme,
			MetricsBindAddress: "0",
		})
		Expect(err).NotTo(HaveOccurred())
		Expect((&HiveClusterReconciler{Client: mgr.GetClient(), Scheme: mgr.GetScheme()}).SetupWithManager(mgr)).To(Succeed())
		Expect((&HiveCompanyReconciler{Client: mgr.GetClient(), Scheme: mgr.GetScheme()}).SetupWithManager(mgr)).To(Succeed())
		Expect((&HiveWorkerPoolReconciler{Client: mgr.GetClient(), Scheme: mgr.GetScheme()}).SetupWithManager(mgr)).To(Succeed())
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		go func() {
			_ = mgr.Start(ctx)
		}()

		ns := "hive-system"
		companyID := "11111111-2222-3333-4444-555555555555"
		tenantNS := "hive-tenant-" + companyID

		// Give manager time to start
		time.Sleep(500 * time.Millisecond)

		// Create namespace
		Expect(k8sClient.Create(ctx, &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: ns}})).To(Succeed())

		// Create provisioner secret
		secret := &corev1.Secret{
			ObjectMeta: metav1.ObjectMeta{Namespace: ns, Name: "provisioner-token"},
			Data:       map[string][]byte{"token": []byte("test-token")},
		}
		Expect(k8sClient.Create(ctx, secret)).To(Succeed())

		// Create HiveCluster (cluster-scoped)
		cluster := testutil.HiveClusterFixture("cluster1", baseURL, "provisioner-token")
		Expect(k8sClient.Create(ctx, cluster)).To(Succeed())

		// Create HiveCompany
		company := testutil.HiveCompanyFixture("company1", ns, companyID)
		Expect(k8sClient.Create(ctx, company)).To(Succeed())

		// Create HiveWorkerPool
		pool := testutil.HiveWorkerPoolFixture("pool1", ns, "company1", "hive-worker:test", 1)
		Expect(k8sClient.Create(ctx, pool)).To(Succeed())

		// Wait for tenant namespace (Company controller)
		Eventually(func() error {
			return k8sClient.Get(ctx, client.ObjectKey{Name: tenantNS}, &corev1.Namespace{})
		}, 10*time.Second, 500*time.Millisecond).Should(Succeed())

		// Wait for Deployment in tenant namespace
		dep := &appsv1.Deployment{}
		Eventually(func() error {
			return k8sClient.Get(ctx, client.ObjectKey{Namespace: tenantNS, Name: "pool1"}, dep)
		}, 15*time.Second, 500*time.Millisecond).Should(Succeed())
		Expect(*dep.Spec.Replicas).To(Equal(int32(1)))
		Expect(dep.Spec.Template.Spec.Containers[0].Image).To(Equal("hive-worker:test"))

		// Wait for Service
		svc := &corev1.Service{}
		Eventually(func() error {
			return k8sClient.Get(ctx, client.ObjectKey{Namespace: tenantNS, Name: "pool1"}, svc)
		}, 5*time.Second, 200*time.Millisecond).Should(Succeed())
		Expect(svc.Spec.Ports).To(HaveLen(1))
		Expect(svc.Spec.Ports[0].Port).To(Equal(int32(8080)))

		// Wait for agent Secret (single replica)
		agentSecret := &corev1.Secret{}
		Eventually(func() error {
			return k8sClient.Get(ctx, client.ObjectKey{Namespace: tenantNS, Name: "pool1-0"}, agentSecret)
		}, 5*time.Second, 200*time.Millisecond).Should(Succeed())
		Expect(agentSecret.Data).To(HaveKey("key"))
		Expect(agentSecret.Data).To(HaveKey("agentId"))

		// Pool status should be updated
		pool2 := &hivev1alpha1.HiveWorkerPool{}
		Eventually(func() int32 {
			_ = k8sClient.Get(ctx, client.ObjectKey{Namespace: ns, Name: "pool1"}, pool2)
			return pool2.Status.HealthyAgents
		}, 5*time.Second, 200*time.Millisecond).Should(Equal(int32(1)))
	})
})
