import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { CopyText } from "@/components/CopyText";
import { workersApi } from "@/api/workers";
import { ApiError } from "@/api/client";

type Props = {
  companyId: string;
  apiBase: string;
  /** Command on PATH after install, e.g. hive-worker or hive-worker.exe */
  workerBinHint: string;
};

/**
 * Mint a company-scoped provisioning token and show env + one-liners to run hive-worker without HIVE_AGENT_ID.
 */
export function WorkerDroneBootstrapSection({ companyId, apiBase, workerBinHint }: Props) {
  const [fresh, setFresh] = useState<{ token: string; expiresAt: string } | null>(null);
  const mint = useMutation({
    mutationFn: () => workersApi.createDroneProvisioningToken(companyId, {}),
    onSuccess: (res) => setFresh(res),
  });

  const tok = fresh?.token;
  const sq = (s: string) => s.replace(/'/g, "'\\''");
  const psq = (s: string) => s.replace(/'/g, "''");

  const posixRunOnly =
    tok != null
      ? `HIVE_CONTROL_PLANE_URL='${sq(apiBase)}' HIVE_DRONE_PROVISION_TOKEN='${sq(tok)}' ${workerBinHint}`
      : "";
  const psRunOnly =
    tok != null
      ? `$env:HIVE_CONTROL_PLANE_URL='${psq(apiBase)}'; $env:HIVE_DRONE_PROVISION_TOKEN='${psq(tok)}'; ${workerBinHint}`
      : "";

  const installShUrl = `${apiBase}/api/worker-downloads/install.sh`;
  const installPsUrl = `${apiBase}/api/worker-downloads/install.ps1`;

  /**
   * Pipe install only needs the token: `install.sh` / `install.ps1` bake the board HTTP origin from the GET
   * request; the script sets `HIVE_CONTROL_PLANE_URL` for `hive-worker` when unset. Override that env yourself
   * only if the worker must use a different API base than the install URL.
   */
  const posixPipe =
    tok != null
      ? `curl -fsSL '${sq(installShUrl)}' | HIVE_DRONE_PROVISION_TOKEN='${sq(tok)}' bash`
      : "";
  const psPipe =
    tok != null ? `$env:HIVE_DRONE_PROVISION_TOKEN='${psq(tok)}'; irm '${psq(installPsUrl)}' | iex` : "";

  return (
    <section
      className="rounded-lg border border-border bg-card p-4 space-y-3"
      aria-labelledby="drone-bootstrap-heading"
    >
      <div>
        <h2 id="drone-bootstrap-heading" className="text-sm font-medium text-foreground">
          Drone-first host bootstrap
        </h2>
        <p className="text-xs text-muted-foreground mt-1 max-w-3xl">
          Generate a <strong className="text-foreground">short-lived provisioning token</strong> to run{" "}
          <code className="font-mono text-[11px]">hive-worker</code> on a host <strong className="text-foreground">without</strong> a board identity or{" "}
          <code className="font-mono text-[11px]">HIVE_AGENT_ID</code>. After the first successful hello, attach identities from this page (Assign to drone / Attach
          identity on a drone row). Treat the token like a password — do not paste it into logs, chat, or tickets.
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="secondary"
          disabled={mint.isPending}
          onClick={() => {
            setFresh(null);
            mint.mutate();
          }}
        >
          {mint.isPending ? "Generating…" : "Generate host bootstrap token"}
        </Button>
        {fresh ? (
          <span className="text-xs text-muted-foreground">Expires {new Date(fresh.expiresAt).toLocaleString()}</span>
        ) : null}
      </div>
      {mint.isError ? (
        <p className="text-xs text-destructive">
          {mint.error instanceof ApiError ? mint.error.message : "Could not mint provisioning token."}
        </p>
      ) : null}
      {tok ? (
        <div className="space-y-4 rounded-md border border-border bg-muted/20 p-3 text-xs">
          <p className="font-medium text-foreground">Copy immediately — the lines below contain the secret token</p>

          <div className="space-y-2">
            <p className="text-[11px] text-muted-foreground">
              Install from this board and start the worker (same release URLs as here). Only the token is required — the
              script already knows the board URL from your <code className="font-mono text-[11px]">install.sh</code> /{" "}
              <code className="font-mono text-[11px]">install.ps1</code> request. Set <code className="font-mono text-[11px]">HIVE_CONTROL_PLANE_URL</code>{" "}
              yourself only if the worker must call a different API than that URL.
            </p>
            <div>
              <span className="text-muted-foreground">POSIX</span>
              <div className="rounded-md bg-muted/50 p-2 font-mono whitespace-pre-wrap break-all mt-1">
                <CopyText text={posixPipe} className="text-foreground">
                  {posixPipe}
                </CopyText>
              </div>
            </div>
            <div>
              <span className="text-muted-foreground">PowerShell</span>
              <div className="rounded-md bg-muted/50 p-2 font-mono whitespace-pre-wrap break-all mt-1">
                <CopyText text={psPipe} className="text-foreground">
                  {psPipe}
                </CopyText>
              </div>
            </div>
          </div>

          <div className="space-y-2 border-t border-border pt-3">
            <p className="text-[11px] text-muted-foreground">Binary already installed — run only</p>
            <div>
              <span className="text-muted-foreground">POSIX</span>
              <div className="rounded-md bg-muted/50 p-2 font-mono whitespace-pre-wrap break-all mt-1">
                <CopyText text={posixRunOnly} className="text-foreground">
                  {posixRunOnly}
                </CopyText>
              </div>
            </div>
            <div>
              <span className="text-muted-foreground">PowerShell</span>
              <div className="rounded-md bg-muted/50 p-2 font-mono whitespace-pre-wrap break-all mt-1">
                <CopyText text={psRunOnly} className="text-foreground">
                  {psRunOnly}
                </CopyText>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
