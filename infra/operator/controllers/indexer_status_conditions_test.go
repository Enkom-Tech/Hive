package controllers

import (
	"testing"

	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

func TestApplyIndexerDegradedCondition_healthyNoGateway(t *testing.T) {
	var conds []metav1.Condition
	applyIndexerDegradedCondition(&conds, true, false, true, 3)
	c := meta.FindStatusCondition(conds, ConditionIndexerDegraded)
	if c == nil {
		t.Fatal("expected IndexerDegraded condition")
	}
	if c.Status != metav1.ConditionFalse {
		t.Fatalf("expected Status False, got %q reason=%q", c.Status, c.Reason)
	}
	if c.ObservedGeneration != 3 {
		t.Fatalf("expected ObservedGeneration 3, got %d", c.ObservedGeneration)
	}
}

func TestApplyIndexerDegradedCondition_dataPlaneNotReady(t *testing.T) {
	var conds []metav1.Condition
	applyIndexerDegradedCondition(&conds, false, false, true, 1)
	c := meta.FindStatusCondition(conds, ConditionIndexerDegraded)
	if c == nil || c.Status != metav1.ConditionTrue || c.Reason != "DataPlaneNotReady" {
		t.Fatalf("expected True DataPlaneNotReady, got %#v", c)
	}
}

func TestApplyIndexerDegradedCondition_gatewayNotReady(t *testing.T) {
	var conds []metav1.Condition
	applyIndexerDegradedCondition(&conds, true, true, false, 2)
	c := meta.FindStatusCondition(conds, ConditionIndexerDegraded)
	if c == nil || c.Status != metav1.ConditionTrue || c.Reason != "GatewayDeploymentNotReady" {
		t.Fatalf("expected True GatewayDeploymentNotReady, got %#v", c)
	}
}
