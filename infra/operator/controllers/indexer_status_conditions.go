package controllers

import (
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// ConditionIndexerDegraded is True when the tenant indexer stack (and optional MCP gateway) is not fully healthy.
const ConditionIndexerDegraded = "IndexerDegraded"

// applyIndexerDegradedCondition sets ConditionIndexerDegraded from data-plane and optional gateway readiness.
// dataPlaneReady is true when all required indexer Deployments have at least one ready replica.
func applyIndexerDegradedCondition(conditions *[]metav1.Condition, dataPlaneReady bool, gatewayWanted bool, gatewayReady bool, observedGen int64) {
	degraded := !dataPlaneReady || (gatewayWanted && !gatewayReady)
	reason := "IndexerHealthy"
	message := "Indexer data plane and gateway (if configured) have ready replicas."
	if !dataPlaneReady {
		reason = "DataPlaneNotReady"
		message = "One or more indexer Deployments have no ready replicas."
	} else if gatewayWanted && !gatewayReady {
		reason = "GatewayDeploymentNotReady"
		message = "MCP gateway Deployment has no ready replicas."
	}

	c := metav1.Condition{
		Type:               ConditionIndexerDegraded,
		Status:             metav1.ConditionFalse,
		ObservedGeneration: observedGen,
		LastTransitionTime: metav1.Now(),
		Reason:             reason,
		Message:            message,
	}
	if degraded {
		c.Status = metav1.ConditionTrue
	}
	meta.SetStatusCondition(conditions, c)
}
