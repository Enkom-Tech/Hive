/**
 * Reference env contracts for operators automating hive-worker on Docker/VPS or Kubernetes.
 * Does not mint secrets — documents where to obtain them from the board API.
 */
export function buildDroneAutoDeployProfile(input: {
  companyId: string;
  target: "docker" | "k3s";
  apiPublicBaseUrl: string;
}): Record<string, unknown> {
  const base = input.apiPublicBaseUrl.replace(/\/$/, "");
  const manifestUrl = `${base}/api/companies/${input.companyId}/worker-runtime/manifest`;
  const provisionTokenPath = `POST ${base}/api/companies/${input.companyId}/drone-provisioning-tokens`;

  const common = {
    companyId: input.companyId,
    controlPlaneHttpBase: base,
    hiveProvisionManifestUrl: manifestUrl,
    obtainDroneProvisionToken: provisionTokenPath,
    recommendedWorkerEnv: {
      HIVE_CONTROL_PLANE_URL: base,
      HIVE_DRONE_PROVISION_TOKEN: "<hive_dpv_… from board or API>",
      HIVE_PROVISION_MANIFEST_URL: manifestUrl,
      HIVE_PROVISION_MANIFEST_PUBLIC_KEY: "<when manifest signing enabled on server>",
      HIVE_PROVISION_CACHE_DIR: "/cache",
      HIVE_PROVISION_MANIFEST_HOOKS: "0",
    },
    repoReferences: [
      "infra/worker/docker-compose.drone.yml",
      "infra/worker/auto-deploy/docker-compose.auto-drone.yml",
      "infra/worker/auto-deploy/k3s-provisioner.example.yaml",
      "infra/worker/PROVISIONER-SPLIT.md",
    ],
  };

  if (input.target === "docker") {
    return {
      target: "docker",
      ...common,
      composeQuickstart: "docker compose -f infra/worker/auto-deploy/docker-compose.auto-drone.yml --env-file .env.drone up -d",
    };
  }

  return {
    target: "k3s",
    ...common,
    operatorNote:
      "Use HiveWorkerPool (infra/operator) for in-cluster agent creation, or apply k3s manifests referencing the same env contract as Docker.",
    k8sReferences: [
      "control-plane/docs/deploy/hive-worker-kubernetes-operator.md",
      "infra/worker/auto-deploy/k3s-provisioner.example.yaml",
    ],
  };
}
