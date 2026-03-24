package controllers

import (
	"context"
	"net/http"
	"net/http/httptest"
	"time"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	logf "sigs.k8s.io/controller-runtime/pkg/log"
	"sigs.k8s.io/controller-runtime/pkg/log/zap"
	metricsserver "sigs.k8s.io/controller-runtime/pkg/metrics/server"

	hivev1alpha1 "github.com/Enkom-Tech/hive-operator/api/v1alpha1"
	"github.com/Enkom-Tech/hive-operator/internal/testutil"
)

var _ = Describe("Cluster controller", func() {
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

	It("sets Connected=true when control plane health returns 200", func() {
		srv := startMockHealthServer(http.StatusOK)
		defer srv.Close()

		mgr, err := ctrl.NewManager(cfg, ctrl.Options{
			Scheme:  testScheme,
			Metrics: metricsserver.Options{BindAddress: "0"},
		})
		Expect(err).NotTo(HaveOccurred())
		Expect((&HiveClusterReconciler{Client: mgr.GetClient(), Scheme: mgr.GetScheme()}).SetupWithManager(mgr)).To(Succeed())
		go func() {
			_ = mgr.Start(ctx)
		}()

		time.Sleep(500 * time.Millisecond)

		ns := "hive-system"
		Expect(k8sClient.Create(ctx, &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: ns}})).To(Succeed())
		Expect(k8sClient.Create(ctx, &corev1.Secret{
			ObjectMeta: metav1.ObjectMeta{Namespace: ns, Name: "prov"},
			Data:       map[string][]byte{"token": []byte("t")},
		})).To(Succeed())

		cluster := testutil.HiveClusterFixture("cluster1", srv.URL, "prov")
		Expect(k8sClient.Create(ctx, cluster)).To(Succeed())

		cluster2 := &hivev1alpha1.HiveCluster{}
		Eventually(func() bool {
			if err := k8sClient.Get(ctx, client.ObjectKey{Name: "cluster1"}, cluster2); err != nil {
				return false
			}
			return cluster2.Status.Connected
		}, 15*time.Second, 500*time.Millisecond).Should(BeTrue())
	})

	It("sets Connected=false when control plane is unreachable", func() {
		mgr, err := ctrl.NewManager(cfg, ctrl.Options{
			Scheme:  testScheme,
			Metrics: metricsserver.Options{BindAddress: "0"},
		})
		Expect(err).NotTo(HaveOccurred())
		Expect((&HiveClusterReconciler{Client: mgr.GetClient(), Scheme: mgr.GetScheme()}).SetupWithManager(mgr)).To(Succeed())
		go func() {
			_ = mgr.Start(ctx)
		}()

		time.Sleep(500 * time.Millisecond)

		ns := "hive-system"
		Expect(k8sClient.Create(ctx, &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: ns}})).To(Succeed())
		Expect(k8sClient.Create(ctx, &corev1.Secret{
			ObjectMeta: metav1.ObjectMeta{Namespace: ns, Name: "prov"},
			Data:       map[string][]byte{"token": []byte("t")},
		})).To(Succeed())

		cluster := testutil.HiveClusterFixture("cluster2", "http://127.0.0.1:19999", "prov")
		Expect(k8sClient.Create(ctx, cluster)).To(Succeed())

		cluster2 := &hivev1alpha1.HiveCluster{}
		Eventually(func() bool {
			if err := k8sClient.Get(ctx, client.ObjectKey{Name: "cluster2"}, cluster2); err != nil {
				return false
			}
			return !cluster2.Status.Connected
		}, 10*time.Second, 500*time.Millisecond).Should(BeTrue())
	})
})

func startMockHealthServer(status int) *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/health" {
			w.WriteHeader(status)
			return
		}
		w.WriteHeader(http.StatusNotFound)
	}))
}
