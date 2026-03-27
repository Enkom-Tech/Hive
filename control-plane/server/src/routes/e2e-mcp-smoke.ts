import { timingSafeEqual } from "node:crypto";
import { Router } from "express";
import { and, eq, notInArray } from "drizzle-orm";
import type { Db } from "@hive/db";
import { agents, workerInstanceAgents, workerInstances } from "@hive/db";
import { mintWorkerApiToken } from "../auth/worker-jwt.js";

const STABLE_INSTANCE_ID = "e2e-mcp-smoke-drone";

function safeEqualUtf8(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function e2eMcpSmokeRoutes(
  db: Db,
  opts: { materializeSecret: string; serverPort: number },
): Router {
  const router = Router();
  const expectedSecret = opts.materializeSecret.trim();

  router.post("/materialize", async (req, res) => {
    const hdr = req.headers["x-hive-e2e-mcp-secret"];
    const got =
      typeof hdr === "string" ? hdr.trim() : Array.isArray(hdr) ? (hdr[0]?.trim() ?? "") : "";
    if (!safeEqualUtf8(got, expectedSecret)) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }

    if (!process.env.HIVE_WORKER_JWT_SECRET?.trim()) {
      res.status(503).json({
        error: "worker_jwt_unconfigured",
        message: "Set HIVE_WORKER_JWT_SECRET so worker JWTs can be minted.",
      });
      return;
    }

    const agentRow = await db
      .select({ id: agents.id, companyId: agents.companyId })
      .from(agents)
      .where(notInArray(agents.status, ["terminated", "pending_approval"]))
      .limit(1)
      .then((rows) => rows[0] ?? null);

    if (!agentRow) {
      res.status(503).json({
        error: "no_agent",
        message:
          "No usable agents in the database. Run onboarding E2E first or seed agents so this smoke test can bind a worker.",
      });
      return;
    }

    let instanceId: string | null = null;
    const existing = await db
      .select({ id: workerInstances.id })
      .from(workerInstances)
      .where(
        and(
          eq(workerInstances.companyId, agentRow.companyId),
          eq(workerInstances.stableInstanceId, STABLE_INSTANCE_ID),
        ),
      )
      .limit(1)
      .then((rows) => rows[0] ?? null);

    if (existing) {
      instanceId = existing.id;
    } else {
      try {
        const [created] = await db
          .insert(workerInstances)
          .values({
            companyId: agentRow.companyId,
            stableInstanceId: STABLE_INSTANCE_ID,
            displayLabel: "e2e-mcp-smoke",
            metadata: {},
            labels: {},
          })
          .returning({ id: workerInstances.id });
        instanceId = created?.id ?? null;
      } catch {
        const again = await db
          .select({ id: workerInstances.id })
          .from(workerInstances)
          .where(
            and(
              eq(workerInstances.companyId, agentRow.companyId),
              eq(workerInstances.stableInstanceId, STABLE_INSTANCE_ID),
            ),
          )
          .limit(1)
          .then((rows) => rows[0] ?? null);
        instanceId = again?.id ?? null;
      }
    }

    if (!instanceId) {
      res.status(500).json({ error: "worker_instance_upsert_failed" });
      return;
    }

    const now = new Date();
    await db
      .insert(workerInstanceAgents)
      .values({
        workerInstanceId: instanceId,
        agentId: agentRow.id,
        assignmentSource: "manual",
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: workerInstanceAgents.agentId,
        set: {
          workerInstanceId: instanceId,
          assignmentSource: "manual",
          updatedAt: now,
        },
      });

    const tokenPack = mintWorkerApiToken(instanceId, agentRow.companyId);
    if (!tokenPack) {
      res.status(503).json({ error: "worker_jwt_mint_failed" });
      return;
    }

    const xfProto = req.get("x-forwarded-proto");
    const proto = (xfProto?.split(",")[0]?.trim() || req.protocol || "http").replace(/:$/, "");
    const host = req.get("host") ?? `127.0.0.1:${opts.serverPort}`;
    const apiBase = `${proto}://${host}`;

    res.status(200).json({
      apiBase,
      companyId: agentRow.companyId,
      agentId: agentRow.id,
      workerInstanceRowId: instanceId,
      workerJwt: tokenPack.token,
    });
  });

  return router;
}
