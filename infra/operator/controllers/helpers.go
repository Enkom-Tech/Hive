package controllers

import "fmt"

func boolPtr(b bool) *bool       { return &b }
func int64Ptr(i int64) *int64    { return &i }

func agentSecretName(poolName string, index int) string {
	return poolName + "-" + fmt.Sprint(index)
}
