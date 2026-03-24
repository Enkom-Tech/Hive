import type { ReactNode } from "react";
import { workerGithubBlob } from "@/lib/worker-github-source";

const links = {
  dockerfile: workerGithubBlob("infra/worker/Dockerfile"),
  dockerDeploy: workerGithubBlob("control-plane/docs/deploy/docker.md"),
  deploymentMatrix: workerGithubBlob("control-plane/docs/deploy/worker-deployment-matrix.md"),
  dockerLegacy: workerGithubBlob("control-plane/doc/DOCKER.md"),
  k3s: workerGithubBlob("control-plane/doc/K3S-LLM-DEPLOYMENT.md"),
  releases: workerGithubBlob("infra/worker/RELEASES.md"),
  managedArch: workerGithubBlob("control-plane/doc/MANAGED-WORKER-ARCHITECTURE.md"),
  poolPlacementPlan: workerGithubBlob("control-plane/doc/plans/worker-pool-and-placement.md"),
} as const;

function DocLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-blue-600 hover:underline dark:text-blue-400 underline-offset-2"
    >
      {children}
    </a>
  );
}

type DeployHiveWorkerGuideContentProps = {
  /** For `aria-labelledby` when embedded with a visible heading. */
  headingId?: string;
  /** When true, omit the duplicate title + intro (e.g. sheet already has `SheetTitle` / `SheetDescription`). */
  hideTitleAndIntro?: boolean;
};

/**
 * Operator-facing deployment paths for hive-worker (bare metal, container, k8s).
 * Used inside {@link WorkerDeployHiveWorkerSheet} and anywhere else deploy copy is needed.
 */
export function DeployHiveWorkerGuideContent({
  headingId = "deploy-hive-worker-guide-heading",
  hideTitleAndIntro = false,
}: DeployHiveWorkerGuideContentProps) {
  return (
    <div className="space-y-4">
      {!hideTitleAndIntro ? (
        <div>
          <h2 id={headingId} className="text-sm font-medium text-foreground">
            Deploy hive-worker
          </h2>
          <p className="text-xs text-muted-foreground mt-1 max-w-3xl">
            Install the binary or image on your infrastructure first, then use <strong className="text-foreground">Assign to drone</strong>{" "}
            on a board identity row below so a running <code className="font-mono text-[11px]">hive-worker</code> connects as that identity.
          </p>
        </div>
      ) : null}

      <p className="text-xs text-muted-foreground">
        Full matrix (VPS, container, Kubernetes, air-gap):{" "}
        <DocLink href={links.deploymentMatrix}>docs/deploy/worker-deployment-matrix</DocLink>.
      </p>

      <ul className="space-y-3 text-xs text-muted-foreground">
        <li className="space-y-1">
          <span className="font-medium text-foreground">On a VM or laptop</span>
          <p>
            Use <strong className="text-foreground">Binary install (this host)</strong> below (pipe or manual download). For a daemon, run{" "}
            <code className="font-mono text-[11px]">hive-worker</code> under systemd or another supervisor with{" "}
            <code className="font-mono text-[11px]">HIVE_CONTROL_PLANE_URL</code> and credentials set — see{" "}
            <DocLink href={links.releases}>infra/worker/RELEASES.md</DocLink> and{" "}
            <DocLink href={links.managedArch}>MANAGED-WORKER-ARCHITECTURE.md</DocLink>.
          </p>
        </li>
        <li className="space-y-1">
          <span className="font-medium text-foreground">Container</span>
          <p>
            Build from <DocLink href={links.dockerfile}>infra/worker/Dockerfile</DocLink>. Compose, env, and control-plane
            networking: <DocLink href={links.dockerDeploy}>docs/deploy/docker</DocLink> and{" "}
            <DocLink href={links.dockerLegacy}>doc/DOCKER.md</DocLink>.
          </p>
        </li>
        <li className="space-y-1">
          <span className="font-medium text-foreground">Kubernetes / k3s</span>
          <p>
            Cluster-oriented notes: <DocLink href={links.k3s}>K3S-LLM-DEPLOYMENT.md</DocLink>. Release archives and checksum
            naming: <DocLink href={links.releases}>infra/worker/RELEASES.md</DocLink>.
          </p>
        </li>
        <li className="space-y-1">
          <span className="font-medium text-foreground">After deploy</span>
          <p>
            Each row in the table is a <strong className="text-foreground">board agent identity</strong> (
            <code className="font-mono text-[11px]">managed_worker</code>). Open <strong className="text-foreground">Assign to drone</strong> for that row to pair,
            mint tokens, and link — that connects your running <code className="font-mono text-[11px]">hive-worker</code>{" "}
            <strong className="text-foreground">as that identity</strong>; it does not replace installing the binary or image on the host.
          </p>
        </li>
      </ul>

      <p className="text-xs text-muted-foreground border-t border-border pt-3">
        <strong className="text-foreground">Roadmap:</strong> automatic placement of work across drones and migration
        between hosts is not built yet — see{" "}
        <DocLink href={links.poolPlacementPlan}>worker-pool-and-placement</DocLink>. Multiple identities on one host: set{" "}
        <code className="font-mono text-[11px]">HIVE_WORKER_LINKS_JSON</code> (see infra/worker docs).
      </p>
    </div>
  );
}
