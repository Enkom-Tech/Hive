package controllers

import (
	"fmt"
	"slices"
	"strings"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	hivev1alpha1 "github.com/Enkom-Tech/hive-operator/api/v1alpha1"
)

const (
	condMCPCodeGateway = "MCPCodeGateway"
	condMCPDocsGateway = "MCPDocsGateway"
)

func mcpCodeIndexerEnv(pool *hivev1alpha1.HiveWorkerPool, list *hivev1alpha1.HiveIndexerList) ([]corev1.EnvVar, metav1.Condition) {
	companyRef := pool.Spec.CompanyRef
	var matches []hivev1alpha1.HiveIndexer
	for i := range list.Items {
		if list.Items[i].Spec.CompanyRef == companyRef {
			matches = append(matches, list.Items[i])
		}
	}
	slices.SortFunc(matches, func(a, b hivev1alpha1.HiveIndexer) int {
		return strings.Compare(a.Name, b.Name)
	})
	want := strings.TrimSpace(pool.Spec.CodeIndexerName)
	var candidates []hivev1alpha1.HiveIndexer
	if want != "" {
		for i := range matches {
			if matches[i].Name == want {
				candidates = append(candidates, matches[i])
				break
			}
		}
		if len(candidates) == 0 {
			return nil, metav1.Condition{
				Type:    condMCPCodeGateway,
				Status:  metav1.ConditionFalse,
				Reason:  "IndexerNotFound",
				Message: fmt.Sprintf("no HiveIndexer named %q for companyRef %s", want, companyRef),
			}
		}
	} else {
		candidates = matches
	}
	if len(candidates) == 0 {
		return nil, metav1.Condition{
			Type:    condMCPCodeGateway,
			Status:  metav1.ConditionUnknown,
			Reason:  "NoHiveIndexer",
			Message: "no HiveIndexer custom resource for this company in the namespace",
		}
	}
	for i := range candidates {
		idx := &candidates[i]
		if !idx.Status.Ready {
			continue
		}
		gu := strings.TrimSpace(idx.Status.GatewayURL)
		gs := strings.TrimSpace(idx.Status.GatewaySecretName)
		if gu != "" && gs != "" {
			base := strings.TrimSuffix(gu, "/") + "/mcp"
			ref := &corev1.EnvVarSource{
				SecretKeyRef: &corev1.SecretKeySelector{
					LocalObjectReference: corev1.LocalObjectReference{Name: gs},
					Key:                  "token",
				},
			}
			env := []corev1.EnvVar{
				{Name: "HIVE_MCP_CODE_URL", Value: base},
				{Name: "HIVE_MCP_CODE_TOKEN", ValueFrom: ref},
				{Name: "HIVE_MCP_URL", Value: base},
				{Name: "HIVE_MCP_TOKEN", ValueFrom: ref},
			}
			return env, metav1.Condition{
				Type:    condMCPCodeGateway,
				Status:  metav1.ConditionTrue,
				Reason:  "Wired",
				Message: fmt.Sprintf("using HiveIndexer/%s", idx.Name),
			}
		}
	}
	var readyBroken []string
	var notReady []string
	for i := range candidates {
		idx := &candidates[i]
		if idx.Status.Ready {
			if strings.TrimSpace(idx.Status.GatewayURL) == "" || strings.TrimSpace(idx.Status.GatewaySecretName) == "" {
				readyBroken = append(readyBroken, idx.Name)
			}
		} else {
			notReady = append(notReady, idx.Name)
		}
	}
	if len(readyBroken) > 0 {
		return nil, metav1.Condition{
			Type:    condMCPCodeGateway,
			Status:  metav1.ConditionFalse,
			Reason:  "GatewayIncomplete",
			Message: fmt.Sprintf("ready indexer(s) missing gateway URL or secret: %s", strings.Join(readyBroken, ",")),
		}
	}
	msg := "waiting for indexer to become ready"
	if len(notReady) > 0 {
		msg = fmt.Sprintf("waiting for indexer ready: %s", strings.Join(notReady, ","))
	}
	return nil, metav1.Condition{
		Type:    condMCPCodeGateway,
		Status:  metav1.ConditionUnknown,
		Reason:  "WaitingForIndexerReady",
		Message: msg,
	}
}

func mcpDocIndexerEnv(pool *hivev1alpha1.HiveWorkerPool, list *hivev1alpha1.HiveDocIndexerList) ([]corev1.EnvVar, metav1.Condition) {
	companyRef := pool.Spec.CompanyRef
	var matches []hivev1alpha1.HiveDocIndexer
	for i := range list.Items {
		if list.Items[i].Spec.CompanyRef == companyRef {
			matches = append(matches, list.Items[i])
		}
	}
	slices.SortFunc(matches, func(a, b hivev1alpha1.HiveDocIndexer) int {
		return strings.Compare(a.Name, b.Name)
	})
	want := strings.TrimSpace(pool.Spec.DocIndexerName)
	var candidates []hivev1alpha1.HiveDocIndexer
	if want != "" {
		for i := range matches {
			if matches[i].Name == want {
				candidates = append(candidates, matches[i])
				break
			}
		}
		if len(candidates) == 0 {
			return nil, metav1.Condition{
				Type:    condMCPDocsGateway,
				Status:  metav1.ConditionFalse,
				Reason:  "IndexerNotFound",
				Message: fmt.Sprintf("no HiveDocIndexer named %q for companyRef %s", want, companyRef),
			}
		}
	} else {
		candidates = matches
	}
	if len(candidates) == 0 {
		return nil, metav1.Condition{
			Type:    condMCPDocsGateway,
			Status:  metav1.ConditionUnknown,
			Reason:  "NoHiveDocIndexer",
			Message: "no HiveDocIndexer custom resource for this company in the namespace",
		}
	}
	for i := range candidates {
		idx := &candidates[i]
		if !idx.Status.Ready {
			continue
		}
		gu := strings.TrimSpace(idx.Status.GatewayURL)
		gs := strings.TrimSpace(idx.Status.GatewaySecretName)
		if gu != "" && gs != "" {
			base := strings.TrimSuffix(gu, "/") + "/mcp"
			ref := &corev1.EnvVarSource{
				SecretKeyRef: &corev1.SecretKeySelector{
					LocalObjectReference: corev1.LocalObjectReference{Name: gs},
					Key:                  "token",
				},
			}
			env := []corev1.EnvVar{
				{Name: "HIVE_MCP_DOCS_URL", Value: base},
				{Name: "HIVE_MCP_DOCS_TOKEN", ValueFrom: ref},
			}
			return env, metav1.Condition{
				Type:    condMCPDocsGateway,
				Status:  metav1.ConditionTrue,
				Reason:  "Wired",
				Message: fmt.Sprintf("using HiveDocIndexer/%s", idx.Name),
			}
		}
	}
	var readyBroken []string
	var notReady []string
	for i := range candidates {
		idx := &candidates[i]
		if idx.Status.Ready {
			if strings.TrimSpace(idx.Status.GatewayURL) == "" || strings.TrimSpace(idx.Status.GatewaySecretName) == "" {
				readyBroken = append(readyBroken, idx.Name)
			}
		} else {
			notReady = append(notReady, idx.Name)
		}
	}
	if len(readyBroken) > 0 {
		return nil, metav1.Condition{
			Type:    condMCPDocsGateway,
			Status:  metav1.ConditionFalse,
			Reason:  "GatewayIncomplete",
			Message: fmt.Sprintf("ready doc indexer(s) missing gateway URL or secret: %s", strings.Join(readyBroken, ",")),
		}
	}
	msg := "waiting for doc indexer to become ready"
	if len(notReady) > 0 {
		msg = fmt.Sprintf("waiting for doc indexer ready: %s", strings.Join(notReady, ","))
	}
	return nil, metav1.Condition{
		Type:    condMCPDocsGateway,
		Status:  metav1.ConditionUnknown,
		Reason:  "WaitingForIndexerReady",
		Message: msg,
	}
}

func mergeWorkerPoolMCPConditions(existing []metav1.Condition, gen int64, code, doc metav1.Condition) []metav1.Condition {
	filtered := make([]metav1.Condition, 0, len(existing))
	for _, c := range existing {
		if c.Type != condMCPCodeGateway && c.Type != condMCPDocsGateway {
			filtered = append(filtered, c)
		}
	}
	filtered = upsertWorkerPoolCondition(filtered, gen, code)
	filtered = upsertWorkerPoolCondition(filtered, gen, doc)
	return filtered
}

func upsertWorkerPoolCondition(existing []metav1.Condition, gen int64, next metav1.Condition) []metav1.Condition {
	for i := range existing {
		if existing[i].Type != next.Type {
			continue
		}
		prev := existing[i]
		if prev.Status == next.Status && prev.Reason == next.Reason && prev.Message == next.Message {
			next.LastTransitionTime = prev.LastTransitionTime
		} else {
			next.LastTransitionTime = metav1.Now()
		}
		next.ObservedGeneration = gen
		existing[i] = next
		return existing
	}
	next.LastTransitionTime = metav1.Now()
	next.ObservedGeneration = gen
	return append(existing, next)
}
