# Hive Kubernetes operator

Reconciles `HiveCompany`, `HiveCluster`, and `HiveWorkerPool` custom resources: tenant namespaces, control-plane provisioning, and worker Deployments.

**Worker pools and the `managed_worker` model:** The operator creates board agents and points their HTTP adapter at the in-cluster worker Service. Primary execution still uses the **outbound WebSocket** from `hive-worker` to the control plane. See `control-plane/docs/deploy/hive-worker-kubernetes-operator.md` in the repository (published docs: Hive → Deploy).
