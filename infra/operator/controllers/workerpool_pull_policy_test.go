package controllers

import (
	"testing"

	corev1 "k8s.io/api/core/v1"
)

func TestWorkerImagePullPolicy(t *testing.T) {
	t.Parallel()
	if g, w := workerImagePullPolicy("ghcr.io/org/hive-worker:v1.2.3"), corev1.PullAlways; g != w {
		t.Fatalf("mutable tag: got %v want %v", g, w)
	}
	if g, w := workerImagePullPolicy("ghcr.io/org/hive-worker@sha256:deadbeef"), corev1.PullIfNotPresent; g != w {
		t.Fatalf("digest: got %v want %v", g, w)
	}
}
