import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DEFAULT_E2E_MCP_MATERIALIZE_SECRET =
  process.env.HIVE_E2E_MCP_MATERIALIZE_SECRET ?? "hive-e2e-mcp-materialize-secret";

function resolveHiveWorkerBinary(): string | null {
  const fromEnv = process.env.HIVE_E2E_HIVE_WORKER_BINARY?.trim();
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  const repoRoot = path.join(__dirname, "..", "..", "..");
  const name = process.platform === "win32" ? "hive-worker.exe" : "hive-worker";
  const candidate = path.join(repoRoot, "infra", "worker", name);
  if (existsSync(candidate)) return candidate;
  return null;
}

function findRpcLine(stdout: string, id: number): { result?: unknown; error?: unknown } | null {
  for (const line of stdout.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    let o: { id?: number; result?: unknown; error?: unknown };
    try {
      o = JSON.parse(t) as { id?: number; result?: unknown; error?: unknown };
    } catch {
      continue;
    }
    if (o.id !== id) continue;
    return o;
  }
  return null;
}

/**
 * Runs after onboarding.spec.ts alphabetically: materialize needs at least one agent.
 * Requires a built hive-worker binary (CI builds infra/worker) or HIVE_E2E_HIVE_WORKER_BINARY.
 */
test.describe("MCP → worker-api smoke", () => {
  test("issue.create via hive-worker stdio MCP is readable via worker-api GET", async ({ request }) => {
    const bin = resolveHiveWorkerBinary();
    test.skip(!bin, "Build hive-worker in infra/worker or set HIVE_E2E_HIVE_WORKER_BINARY");

    const mat = await request.post("/api/e2e/mcp-smoke/materialize", {
      headers: { "X-Hive-E2E-MCP-Secret": DEFAULT_E2E_MCP_MATERIALIZE_SECRET },
    });

    if (mat.status() === 503) {
      const j = (await mat.json().catch(() => ({}))) as { error?: string };
      test.skip(
        j.error === "no_agent",
        "No agent yet — onboarding.spec.ts should run first in this Playwright project (fullyParallel: false)",
      );
    }

    expect(mat.ok(), `materialize failed: ${await mat.text()}`).toBeTruthy();

    const materialized = (await mat.json()) as {
      apiBase: string;
      agentId: string;
      workerJwt: string;
    };

    const stateDir = mkdtempSync(path.join(tmpdir(), "hive-mcp-e2e-"));
    writeFileSync(path.join(stateDir, "worker-jwt"), `${materialized.workerJwt}\n`);

    const input = [
      '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"e2e","version":"1.0"}}}',
      '{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}',
      '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"issue.create","arguments":{"title":"E2E MCP smoke issue","idempotencyKey":"e2e-mcp-smoke-issue-v1"}}}',
    ].join("\n");

    const proc = spawnSync(bin, ["mcp"], {
      input: `${input}\n`,
      encoding: "utf-8",
      env: {
        ...process.env,
        HIVE_CONTROL_PLANE_URL: materialized.apiBase,
        HIVE_AGENT_ID: materialized.agentId,
        HIVE_WORKER_STATE_DIR: stateDir,
      },
      maxBuffer: 10 * 1024 * 1024,
    });

    expect(proc.error, proc.error?.message).toBeUndefined();
    expect(proc.status, `stderr: ${proc.stderr}`).toBe(0);

    const rpc = findRpcLine(proc.stdout ?? "", 2);
    expect(rpc?.error, JSON.stringify(rpc?.error)).toBeUndefined();

    const mcpResult = rpc?.result as { content?: Array<{ text?: string }> } | undefined;
    const text = mcpResult?.content?.[0]?.text;
    expect(text).toBeTruthy();
    const apiPayload = JSON.parse(text!) as { ok?: boolean; result?: { issue?: { id?: string } } };
    const issueId = apiPayload?.result?.issue?.id;
    expect(issueId).toBeTruthy();

    const getRes = await request.get(
      `/api/worker-api/issues/${issueId}?agentId=${encodeURIComponent(materialized.agentId)}`,
      {
        headers: { Authorization: `Bearer ${materialized.workerJwt}` },
      },
    );
    expect(getRes.ok(), await getRes.text()).toBeTruthy();
    const issueJson = (await getRes.json()) as { ok?: boolean; result?: { issueId?: string } };
    expect(issueJson.result?.issueId).toBe(issueId);
  });
});
