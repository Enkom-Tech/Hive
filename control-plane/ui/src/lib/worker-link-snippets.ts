/**
 * Copy-paste commands for `hive worker link` (POSIX / PowerShell).
 * Keep token out of logs in UI — only show in intentional copy blocks.
 */

function escapePosixSingleQuoted(s: string): string {
  return s.replace(/'/g, "'\\''");
}

function escapePsSingleQuoted(s: string): string {
  return s.replace(/'/g, "''");
}

export function buildPosixWorkerLinkSnippet(opts: {
  agentId: string;
  apiBase: string;
  enrollmentToken?: string | null;
  workerBin: string;
}): string {
  const api = escapePosixSingleQuoted(opts.apiBase);
  const bin = opts.workerBin;
  const id = opts.agentId;
  if (opts.enrollmentToken) {
    const tok = escapePosixSingleQuoted(opts.enrollmentToken);
    return `export HIVE_WORKER_ENROLLMENT_TOKEN='${tok}'
pnpm hive worker link --agent-id ${id} --api-base '${api}' --worker-bin ${bin}`;
  }
  return `pnpm hive worker link --agent-id ${id} --api-base '${api}' --worker-bin ${bin}`;
}

export function buildPowerShellWorkerLinkSnippet(opts: {
  agentId: string;
  apiBase: string;
  enrollmentToken?: string | null;
  workerBin: string;
}): string {
  const api = escapePsSingleQuoted(opts.apiBase);
  const bin = opts.workerBin;
  const id = opts.agentId;
  if (opts.enrollmentToken) {
    const tok = escapePsSingleQuoted(opts.enrollmentToken);
    return `$env:HIVE_WORKER_ENROLLMENT_TOKEN = '${tok}'
pnpm hive worker link --agent-id ${id} --api-base '${api}' --worker-bin ${bin}`;
  }
  return `pnpm hive worker link --agent-id ${id} --api-base '${api}' --worker-bin ${bin}`;
}

/** Single line: set enrollment env and run Hive CLI (POSIX). */
export function buildPosixWorkerEnrollOneliner(opts: {
  agentId: string;
  apiBase: string;
  enrollmentToken: string;
  workerBin: string;
}): string {
  const api = escapePosixSingleQuoted(opts.apiBase);
  const tok = escapePosixSingleQuoted(opts.enrollmentToken);
  const bin = opts.workerBin;
  const id = opts.agentId;
  return `export HIVE_WORKER_ENROLLMENT_TOKEN='${tok}' && pnpm hive worker link --agent-id ${id} --api-base '${api}' --worker-bin ${bin}`;
}

/** Single line enrollment (PowerShell). */
export function buildPowerShellWorkerEnrollOneliner(opts: {
  agentId: string;
  apiBase: string;
  enrollmentToken: string;
  workerBin: string;
}): string {
  const api = escapePsSingleQuoted(opts.apiBase);
  const tok = escapePsSingleQuoted(opts.enrollmentToken);
  const bin = opts.workerBin;
  const id = opts.agentId;
  return `$env:HIVE_WORKER_ENROLLMENT_TOKEN = '${tok}'; pnpm hive worker link --agent-id ${id} --api-base '${api}' --worker-bin ${bin}`;
}

/** Link + spawn worker only (POSIX), one line — uses hive CLI to set env for child. */
export function buildPosixWorkerLinkOnlyOneliner(opts: {
  agentId: string;
  apiBase: string;
  workerBin: string;
}): string {
  return buildPosixWorkerLinkSnippet(opts).replace(/\n/g, " ").replace(/\s+/g, " ").trim();
}

export function buildPowerShellWorkerLinkOnlyOneliner(opts: {
  agentId: string;
  apiBase: string;
  workerBin: string;
}): string {
  return buildPowerShellWorkerLinkSnippet(opts).replace(/\n/g, " ").replace(/\s+/g, " ").trim();
}
