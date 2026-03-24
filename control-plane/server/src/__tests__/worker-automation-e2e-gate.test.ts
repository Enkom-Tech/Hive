import { describe, it } from "vitest";

/**
 * Full docker/k3s stack tests (provision token, worker-identity slots, heartbeat dispatch)
 * belong in integration/Playwright or a compose-driven CI job — see:
 * - infra/worker/auto-deploy/README.md
 * - .github/workflows/control-plane-e2e.yml
 */
describe("worker automation E2E (CI backlog)", () => {
  it.todo("docker compose: hive-worker + DB + slots + auto-placement end-to-end");
  it.todo("k3s: HiveWorkerPool or provisioner Job + worker Deployment end-to-end");
});
