import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
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

export async function e2eMcpSmokePlugin(
  fastify: FastifyInstance,
  opts: { db: Db; materializeSecret: string; serverPort: number },
): Promise<void> {
  const expectedSecret = opts.materializeSecret.trim();

  fastify.post("/api/e2e/mcp-smoke/materialize", async (req, reply) => {
    const rawHdr = req.headers["x-hive-e2e-mcp-secret"];
    const got =
      typeof rawHdr === "string" ? rawHdr.trim() : Array.isArray(rawHdr) ? (rawHdr[0]?.trim() ?? "") : "";
    if (!safeEqualUtf8(got, expectedSecret)) {
      return reply.status(403).send({ error: "Forbidden" });
    }

    if (!process.env.HIVE_WORKER_JWT_SECRET?.trim()) {
      return reply.status(503).send({
        error: "worker_jwt_unconfigured",
        message: "Set HIVE_WORKER_JWT_SECRET so worker JWTs can be minted.",
      });
    }

    const agentRow = await opts.db
      .select({ id: agents.id, companyId: agents.companyId })
      .from(agents)
      .where(notInArray(agents.status, ["terminated", "pending_approval"]))
      .limit(1)
      .then((rows) => rows[0] ?? null);

    if (!agentRow) {
      return reply.status(503).send({
        error: "no_agent",
        message:
          "No usable agents in the database. Run onboarding E2E first or seed agents so this smoke test can bind a worker.",
      });
    }

    let instanceId: string | null = null;
    const existing = await opts.db
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
        const [created] = await opts.db
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
        const again = await opts.db
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
      return reply.status(500).send({ error: "worker_instance_upsert_failed" });
    }

    const now = new Date();
    await opts.db
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
      return reply.status(503).send({ error: "worker_jwt_mint_failed" });
    }

    const xfProto = (req.headers["x-forwarded-proto"] as string | undefined)?.split(",")[0]?.trim();
    const proto = (xfProto || req.protocol || "http").replace(/:$/, "");
    const host = (req.headers.host as string | undefined) ?? `127.0.0.1:${opts.serverPort}`;
    const apiBase = `${proto}://${host}`;

    return reply.status(200).send({
      apiBase,
      companyId: agentRow.companyId,
      agentId: agentRow.id,
      workerInstanceRowId: instanceId,
      workerJwt: tokenPack.token,
    });
  });
}
