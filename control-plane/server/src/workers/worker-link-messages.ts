import { and, eq, gt, isNull } from "drizzle-orm";
import type { WebSocket } from "ws";
import { droneProvisioningTokens } from "@hive/db";
import { isUuidLike } from "@hive/shared";
import { logger } from "../middleware/logger.js";
import { publishLiveEvent } from "../services/live-events.js";
import {
  agentToInstance,
  pendingByAgent,
  registryByInstance,
  syncWorkerInstanceBindings,
  unregisterConnection,
  type WorkerConnection,
} from "./worker-link-registry.js";
import {
  parseWorkerHelloMessage,
  scheduleWorkerHello,
  touchWorkerInstanceLastSeenAt,
  upsertWorkerInstanceFromHello,
} from "./worker-hello.js";
import type { LinkAuth, WorkerLinkAttachOpts } from "./worker-link-types.js";
import { sendInstanceLinkTokenRefresh, sendWorkerApiToken } from "./worker-link-internal.js";

export function attachWorkerLinkMessageHandler(
  ws: WebSocket,
  connectionId: string,
  conn: WorkerConnection,
  auth: LinkAuth,
  opts: WorkerLinkAttachOpts,
): void {
  ws.on("message", (raw: Buffer | string) => {
    let data: string;
    if (Buffer.isBuffer(raw)) {
      data = raw.toString("utf8");
    } else if (typeof raw === "string") {
      data = raw;
    } else {
      return;
    }

    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(data) as Record<string, unknown>;
    } catch {
      logger.warn({ connectionId }, "worker link invalid JSON");
      return;
    }

    const type = typeof msg.type === "string" ? msg.type : "";
    const enrollingAgentId = auth.kind === "agent" ? auth.agentId : "";

    if (type === "hello") {
      if (auth.kind === "provision") {
        const payload = parseWorkerHelloMessage(msg);
        if (!payload) return;
        void (async () => {
          const { instanceRowId, created: instanceCreated } = await upsertWorkerInstanceFromHello(
            opts.db,
            auth.companyId,
            payload,
          );
          if (!instanceRowId) {
            logger.warn({ connectionId }, "provision hello missing valid instanceId");
            return;
          }
          const consumed = await opts.db
            .update(droneProvisioningTokens)
            .set({ consumedAt: new Date() })
            .where(
              and(
                eq(droneProvisioningTokens.id, auth.provisioningTokenRowId),
                eq(droneProvisioningTokens.companyId, auth.companyId),
                isNull(droneProvisioningTokens.consumedAt),
                gt(droneProvisioningTokens.expiresAt, new Date()),
              ),
            )
            .returning({ id: droneProvisioningTokens.id })
            .then((rows) => rows[0] ?? null);
          if (!consumed) {
            try {
              ws.close(4001, "invalid or consumed provisioning token");
            } catch {
              // ignore
            }
            return;
          }
          conn.workerInstanceRowId = instanceRowId;
          conn.linkMode = "instance";
          conn.provisioningEnrollmentId = undefined;
          const sid = payload.instanceId?.trim() ?? "";
          if (sid && isUuidLike(sid)) {
            conn.stableInstanceId = sid.toLowerCase();
          } else {
            delete conn.stableInstanceId;
          }
          const prev = registryByInstance.get(instanceRowId);
          if (prev && prev.connectionId !== connectionId) {
            try {
              prev.ws.close(4000, "replaced");
            } catch {
              // ignore
            }
            unregisterConnection(prev);
          }
          registryByInstance.set(instanceRowId, conn);
          await syncWorkerInstanceBindings(opts.db, instanceRowId);
          await sendInstanceLinkTokenRefresh(
            ws,
            opts.mintInstanceLinkToken,
            auth.companyId,
            instanceRowId,
            connectionId,
          );
          await sendWorkerApiToken(ws, auth.companyId, instanceRowId, connectionId);
          publishLiveEvent({
            companyId: auth.companyId,
            type: "worker.drone.registered",
            payload: {
              workerInstanceId: instanceRowId,
              stableInstanceId: conn.stableInstanceId ?? payload.instanceId,
              hostname: payload.hostname,
              firstRegistration: instanceCreated,
            },
          });
          if (opts.reconcileAutomaticAssignmentsForCompany) {
            void opts
              .reconcileAutomaticAssignmentsForCompany(auth.companyId)
              .then((r) => {
                if (
                  r.assigned > 0 ||
                  r.attempted > 0 ||
                  (r.identityAgentsCreated ?? 0) > 0 ||
                  (r.identityErrors?.length ?? 0) > 0
                ) {
                  logger.info(
                    {
                      connectionId,
                      companyId: auth.companyId,
                      attempted: r.attempted,
                      assigned: r.assigned,
                      identityAgentsCreated: r.identityAgentsCreated ?? 0,
                      identityErrors: r.identityErrors ?? [],
                    },
                    "worker automation reconcile after provision hello",
                  );
                }
              })
              .catch((err) => {
                logger.error({ err, connectionId, companyId: auth.companyId }, "automatic assignment reconcile failed");
              });
          }
          logger.info({ connectionId, instanceRowId }, "provision hello completed; instance registered");
        })().catch((err) => {
          logger.error({ err, connectionId }, "provision hello failed");
        });
        return;
      }
      if (auth.kind === "agent") {
        scheduleWorkerHello(opts.db, enrollingAgentId, auth.companyId, msg, {
          afterPersist: (payload, result) => {
            const cur = pendingByAgent.get(enrollingAgentId);
            if (!cur || cur.connectionId !== connectionId) return;
            const sid = payload.instanceId?.trim() ?? "";
            if (sid && isUuidLike(sid)) {
              cur.stableInstanceId = sid.toLowerCase();
            } else {
              delete cur.stableInstanceId;
            }
            const iid = result.instanceRowId;
            if (!iid) return;

            pendingByAgent.delete(enrollingAgentId);
            cur.workerInstanceRowId = iid;
            cur.agentIds.add(enrollingAgentId);

            const prev = registryByInstance.get(iid);
            if (prev && prev.connectionId !== connectionId) {
              try {
                prev.ws.close(4000, "replaced");
              } catch {
                // ignore
              }
              unregisterConnection(prev);
            }
            registryByInstance.set(iid, cur);
            for (const aid of cur.agentIds) {
              agentToInstance.set(aid, iid);
            }
            publishLiveEvent({
              companyId: auth.companyId,
              type: "worker.link.connected",
              payload: { workerInstanceId: iid, agentId: enrollingAgentId, linkMode: "agent_hello" },
            });
            void syncWorkerInstanceBindings(opts.db, iid).catch((err) => {
              logger.error({ err, iid }, "syncWorkerInstanceBindings after agent hello failed");
            });
          },
        });
      } else {
        const sid =
          typeof msg.instanceId === "string" && isUuidLike(msg.instanceId.trim())
            ? msg.instanceId.trim().toLowerCase()
            : "";
        if (sid) {
          conn.stableInstanceId = sid;
        } else {
          delete conn.stableInstanceId;
        }
      }
      return;
    }

    const effectiveAgentId =
      typeof msg.agentId === "string" && msg.agentId.trim() !== ""
        ? msg.agentId.trim()
        : enrollingAgentId;

    if (type === "ack" && opts.heartbeat.handleWorkerPlacementAck) {
      void opts.heartbeat.handleWorkerPlacementAck(effectiveAgentId, msg).catch((err) => {
        logger.error({ err, connectionId, effectiveAgentId }, "worker link handleWorkerPlacementAck failed");
      });
      return;
    }
    if (type === "status") {
      const runId = typeof msg.runId === "string" ? msg.runId : "";
      if (runId) {
        void opts.heartbeat.handleWorkerRunStatus(effectiveAgentId, runId, msg).catch((err) => {
          logger.error({ err, effectiveAgentId, runId }, "worker link handleWorkerRunStatus failed");
        });
      }
    } else if (type === "log") {
      const runId = typeof msg.runId === "string" ? msg.runId : "";
      const stream = msg.stream === "stderr" ? "stderr" : "stdout";
      const chunk = typeof msg.chunk === "string" ? msg.chunk : "";
      const ts = typeof msg.ts === "string" ? msg.ts : new Date().toISOString();
      if (runId) {
        void opts.heartbeat.appendWorkerRunLog(runId, stream, chunk, ts).catch((err) => {
          logger.error({ err, effectiveAgentId, runId }, "worker link appendWorkerRunLog failed");
        });
      }
    }
  });
}
