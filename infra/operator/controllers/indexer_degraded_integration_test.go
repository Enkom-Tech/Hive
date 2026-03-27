package controllers

import (
	"context"
	"fmt"
	"time"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"
	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	logf "sigs.k8s.io/controller-runtime/pkg/log"
	"sigs.k8s.io/controller-runtime/pkg/log/zap"
	metricsserver "sigs.k8s.io/controller-runtime/pkg/metrics/server"

	hivev1alpha1 "github.com/Enkom-Tech/hive-operator/api/v1alpha1"
	"github.com/Enkom-Tech/hive-operator/internal/testutil"
)

var _ = Describe("HiveIndexer IndexerDegraded integration (envtest)", func() {
	It("sets IndexerDegraded True without ready replicas and False when Deployment reports ready", func() {
		ctx := context.Background()
		logf.SetLogger(zap.New(zap.WriteTo(GinkgoWriter), zap.UseDevMode(true)))

		mgr, err := ctrl.NewManager(cfg, ctrl.Options{
			Scheme:  testScheme,
			Metrics: metricsserver.Options{BindAddress: "0"},
		})
		Expect(err).NotTo(HaveOccurred())
		Expect((&HiveCompanyReconciler{Client: mgr.GetClient(), Scheme: mgr.GetScheme()}).SetupWithManager(mgr)).To(Succeed())
		Expect((&HiveIndexerReconciler{Client: mgr.GetClient(), Scheme: mgr.GetScheme()}).SetupWithManager(mgr)).To(Succeed())

		mgrCtx, cancel := context.WithCancel(ctx)
		defer cancel()
		go func() { _ = mgr.Start(mgrCtx) }()
		time.Sleep(500 * time.Millisecond)

		ns := "hive-system"
		companyID := "99999999-aaaa-bbbb-cccc-dddddddddddd"
		tenantNS := "hive-tenant-" + companyID

		Expect(k8sClient.Create(ctx, &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: ns}})).To(Succeed())
		company := testutil.HiveCompanyFixture("company1", ns, companyID)
		Expect(k8sClient.Create(ctx, company)).To(Succeed())

		Eventually(func() error {
			return k8sClient.Get(ctx, client.ObjectKey{Name: tenantNS}, &corev1.Namespace{})
		}, 15*time.Second, 200*time.Millisecond).Should(Succeed())

		indexer := testutil.HiveIndexerFixture("idx1", ns, "company1")
		Expect(k8sClient.Create(ctx, indexer)).To(Succeed())

		Eventually(func() error {
			return k8sClient.Get(ctx, client.ObjectKey{Namespace: tenantNS, Name: "idx1"}, &appsv1.Deployment{})
		}, 20*time.Second, 300*time.Millisecond).Should(Succeed())

		Eventually(func() bool {
			idx := &hivev1alpha1.HiveIndexer{}
			if err := k8sClient.Get(ctx, client.ObjectKey{Namespace: ns, Name: "idx1"}, idx); err != nil {
				return false
			}
			c := meta.FindStatusCondition(idx.Status.Conditions, ConditionIndexerDegraded)
			return c != nil && c.Status == metav1.ConditionTrue && c.Reason == "DataPlaneNotReady"
		}, 25*time.Second, 400*time.Millisecond).Should(BeTrue(), "expected IndexerDegraded True when Deployment has no ready replicas")

		dep := &appsv1.Deployment{}
		Expect(k8sClient.Get(ctx, client.ObjectKey{Namespace: tenantNS, Name: "idx1"}, dep)).To(Succeed())
		dep.Status.Replicas = 1
		dep.Status.ReadyReplicas = 1
		dep.Status.AvailableReplicas = 1
		dep.Status.UpdatedReplicas = 1
		Expect(k8sClient.Status().Update(ctx, dep)).To(Succeed())

		idx := &hivev1alpha1.HiveIndexer{}
		Expect(k8sClient.Get(ctx, client.ObjectKey{Namespace: ns, Name: "idx1"}, idx)).To(Succeed())
		base := idx.DeepCopy()
		if idx.Annotations == nil {
			idx.Annotations = map[string]string{}
		}
		idx.Annotations["hive.io/test-reconcile-at"] = fmt.Sprintf("%d", time.Now().UnixNano())
		Expect(k8sClient.Patch(ctx, idx, client.MergeFrom(base))).To(Succeed())

		Eventually(func() bool {
			got := &hivev1alpha1.HiveIndexer{}
			if err := k8sClient.Get(ctx, client.ObjectKey{Namespace: ns, Name: "idx1"}, got); err != nil {
				return false
			}
			c := meta.FindStatusCondition(got.Status.Conditions, ConditionIndexerDegraded)
			return c != nil && c.Status == metav1.ConditionFalse && c.Reason == "IndexerHealthy"
		}, 25*time.Second, 400*time.Millisecond).Should(BeTrue(), "expected IndexerDegraded False when Deployment has ready replicas")
	})
})
