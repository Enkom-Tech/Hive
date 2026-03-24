package controllers

import (
	"context"
	"time"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"
	corev1 "k8s.io/api/core/v1"
	netv1 "k8s.io/api/networking/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	logf "sigs.k8s.io/controller-runtime/pkg/log"
	"sigs.k8s.io/controller-runtime/pkg/log/zap"
	metricsserver "sigs.k8s.io/controller-runtime/pkg/metrics/server"

	"github.com/Enkom-Tech/hive-operator/internal/testutil"
)

var _ = Describe("Company controller", func() {
	var ctx context.Context
	var cancel context.CancelFunc

	BeforeEach(func() {
		logf.SetLogger(zap.New(zap.WriteTo(GinkgoWriter), zap.UseDevMode(true)))
		ctx, cancel = context.WithCancel(context.Background())
	})

	AfterEach(func() {
		if cancel != nil {
			cancel()
		}
	})

	It("creates namespace, PVC, ResourceQuota, and NetworkPolicy when HiveCompany is created", func() {
		mgr, err := ctrl.NewManager(cfg, ctrl.Options{
			Scheme:  testScheme,
			Metrics: metricsserver.Options{BindAddress: "0"},
		})
		Expect(err).NotTo(HaveOccurred())
		Expect((&HiveCompanyReconciler{Client: mgr.GetClient(), Scheme: mgr.GetScheme()}).SetupWithManager(mgr)).To(Succeed())
		go func() {
			_ = mgr.Start(ctx)
		}()

		time.Sleep(500 * time.Millisecond)

		ns := "hive-system"
		companyID := "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
		tenantNS := "hive-tenant-" + companyID

		Expect(k8sClient.Create(ctx, &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: ns}})).To(Succeed())

		company := testutil.HiveCompanyFixture("company1", ns, companyID)
		company.Spec.CPUQuota = "2"
		company.Spec.MemoryQuota = "4Gi"
		Expect(k8sClient.Create(ctx, company)).To(Succeed())

		Eventually(func() error {
			return k8sClient.Get(ctx, client.ObjectKey{Name: tenantNS}, &corev1.Namespace{})
		}, 10*time.Second, 500*time.Millisecond).Should(Succeed())

		pvc := &corev1.PersistentVolumeClaim{}
		Eventually(func() error {
			return k8sClient.Get(ctx, client.ObjectKey{Namespace: tenantNS, Name: "workspace-" + companyID}, pvc)
		}, 5*time.Second, 200*time.Millisecond).Should(Succeed())
		Expect(pvc.Spec.StorageClassName).To(Not(BeNil()))
		Expect(*pvc.Spec.StorageClassName).To(Equal("juicefs-sc"))

		quota := &corev1.ResourceQuota{}
		Eventually(func() error {
			return k8sClient.Get(ctx, client.ObjectKey{Namespace: tenantNS, Name: "hive-quota"}, quota)
		}, 5*time.Second, 200*time.Millisecond).Should(Succeed())
		Expect(quota.Spec.Hard).To(HaveKey(corev1.ResourceLimitsCPU))
		Expect(quota.Spec.Hard).To(HaveKey(corev1.ResourceLimitsMemory))

		np := &netv1.NetworkPolicy{}
		Eventually(func() error {
			return k8sClient.Get(ctx, client.ObjectKey{Namespace: tenantNS, Name: "hive-tenant-default"}, np)
		}, 5*time.Second, 200*time.Millisecond).Should(Succeed())
		Expect(np.Spec.PolicyTypes).To(ContainElement(netv1.PolicyTypeIngress))
		Expect(np.Spec.PolicyTypes).To(ContainElement(netv1.PolicyTypeEgress))
	})

	It("cleans up namespace when HiveCompany is deleted", func() {
		mgr, err := ctrl.NewManager(cfg, ctrl.Options{
			Scheme:  testScheme,
			Metrics: metricsserver.Options{BindAddress: "0"},
		})
		Expect(err).NotTo(HaveOccurred())
		Expect((&HiveCompanyReconciler{Client: mgr.GetClient(), Scheme: mgr.GetScheme()}).SetupWithManager(mgr)).To(Succeed())
		go func() {
			_ = mgr.Start(ctx)
		}()

		time.Sleep(500 * time.Millisecond)

		ns := "hive-system"
		companyID := "bbbbbbbb-cccc-dddd-eeee-ffffffffffff"
		tenantNS := "hive-tenant-" + companyID

		Expect(k8sClient.Create(ctx, &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: ns}})).To(Succeed())
		company := testutil.HiveCompanyFixture("company2", ns, companyID)
		Expect(k8sClient.Create(ctx, company)).To(Succeed())

		Eventually(func() error {
			return k8sClient.Get(ctx, client.ObjectKey{Name: tenantNS}, &corev1.Namespace{})
		}, 10*time.Second, 500*time.Millisecond).Should(Succeed())

		Expect(k8sClient.Delete(ctx, company)).To(Succeed())
		Eventually(func() bool {
			err := k8sClient.Get(ctx, client.ObjectKey{Name: tenantNS}, &corev1.Namespace{})
			return err != nil && client.IgnoreNotFound(err) == nil
		}, 15*time.Second, 500*time.Millisecond).Should(BeTrue())
	})
})
