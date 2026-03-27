import { createHash } from "node:crypto";
import type { IncomingMessage, Server as HttpServer } from "node:http";
import type { Duplex } from "node:stream";
import { and, eq, gt, isNull } from "drizzle-orm";
import type { Db } from "@hive/db";
import {
  agentApiKeys,
  agents,
  droneProvisioningTokens,
  managedWorkerLinkEnrollmentTokens,
  workerInstanceAgents,
  workerInstanceLinkEnrollmentTokens,
} from "@hive/db";
import { isUuidLike } from "@hive/shared";
import { WebSocket, WebSocketServer } from "ws";
import { logger } from "../middleware/logger.js";
import { publishLiveEvent } from "../services/live-events.js";
import {
  agentToInstance,
  findConnectionForAgent,
  pendingByAgent,
  registryByInstance,
  syncWorkerInstanceBindings,
  trySendJsonOnConnection,
  trySendJsonToWorkerInstance,
  unregisterConnection,
  type WorkerConnection,
} from "./worker-link-registry.js";
import {
  parseWorkerHelloMessage,
  scheduleWorkerHello,
  touchWorkerInstanceLastSeenAt,
  upsertWorkerInstanceFromHello,
} from "./worker-hello.js";
import { isWorkerDeliveryRedisConfigured, publishWorkerInstanceDeliver } from "./worker-delivery-redis.js";
import { mintWorkerApiToken } from "../auth/worker-jwt.js";

export type LinkAuth =
  | { kind: "agent"; agentId: string; companyId: string }
  | { kind: "instance"; workerInstanceRowId: string; companyId: string; boundAgentIds: string[] }
  | { kind: "provision"; companyId: string; provisioningTokenRowId: string };

export { trySendJsonToWorkerInstance };

const WORKER_LINK_PATH = "/api/workers/link";

let connectionIdCounter = 0;

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function rejectUpgrade(socket: Duplex, statusLine: string, message: string) {
  const safe = message.replace(/[\r\n]+/g, " ").trim();
  socket.write(
    `HTTP/1.1 ${statusLine}\r\nConnection: close\r\nContent-Type: text/plain\r\n\r\n${safe}`,
  );
  socket.destroy();
}

export type HeartbeatWorkerLink = {
  appendWorkerRunLog(
    runId: string,
    stream: "stdout" | "stderr",
    chunk: string,
    ts: string,
  ): Promise<void>;
  handleWorkerRunStatus(
    agentId: string,
    runId: string,
    payload: Record<string, unknown>,
  ): Promise<void>;
  handleWorkerPlacementAck?(agentId: string, payload: Record<string, unknown>): Promise<void>;
};

/** Mints a fresh worker-instance link enrollment secret so the drone can persist it and reconnect without reusing a one-time provision token. */
export type MintInstanceLinkToken = (
  companyId: string,
  workerInstanceId: string,
) => Promise<{ token: string; expiresAt: Date }>;

async function sendInstanceLinkTokenRefresh(
  ws: WebSocket,
  mint: MintInstanceLinkToken | undefined,
  companyId: string,
  workerInstanceRowId: string,
  connectionId: string,
) {
  if (!mint) return;
  if (ws.readyState !== WebSocket.OPEN) return;
  try {
    const { token, expiresAt } = await mint(companyId, workerInstanceRowId);
    ws.send(
      JSON.stringify({
        type: "link_token",
        token,
        expiresAt: expiresAt.toISOString(),
      }),
    );
    logger.info({ connectionId, workerInstanceRowId }, "worker link sent link_token for reconnect");
  } catch (err) {
    logger.error({ err, connectionId, workerInstanceRowId }, "worker link failed to mint link_token");
  }
}

async function sendWorkerApiToken(
  ws: WebSocket,
  companyId: string,
  workerInstanceRowId: string,
  connectionId: string,
) {
  if (ws.readyState !== WebSocket.OPEN) return;
  const minted = mintWorkerApiToken(workerInstanceRowId, companyId);
  if (!minted) return;
  try {
    ws.send(
      JSON.stringify({
        type: "worker_api_token",
        token: minted.token,
        expiresAt: minted.expiresAt.toISOString(),
      }),
    );
    logger.info({ connectionId, workerInstanceRowId }, "worker link sent worker_api_token");
  } catch (err) {
    logger.error({ err, connectionId, workerInstanceRowId }, "worker link failed to send worker_api_token");
  }
}

export function attachWorkerLinkUpgrade(
  server: HttpServer,
  opts: {
    db: Db;
    heartbeat: HeartbeatWorkerLink;
    mintInstanceLinkToken?: MintInstanceLinkToken;
    reconcileAutomaticAssignmentsForCompany?: (companyId: string) => Promise<{
      attempted: number;
      assigned: number;
      identityAgentsCreated?: number;
      identityErrors?: string[];
    }>;
  },
) {
  const wss = new WebSocketServer({ noServer: true });

  wss.on("connection", (ws: WebSocket, _req: IncomingMessage, auth: LinkAuth) => {
    const connectionId = `wl-${++connectionIdCounter}`;

    const conn: WorkerConnection = {
      ws,
      connectionId,
      companyId: auth.companyId,
      linkMode:
        auth.kind === "agent" ? "agent" : auth.kind === "provision" ? "provision" : "instance",
      primaryAgentId: auth.kind === "agent" ? auth.agentId : undefined,
      agentIds: new Set(),
      workerInstanceRowId: auth.kind === "instance" ? auth.workerInstanceRowId : undefined,
      provisioningEnrollmentId: auth.kind === "provision" ? auth.provisioningTokenRowId : undefined,
    };

    if (auth.kind === "agent") {
      conn.agentIds.add(auth.agentId);
      const previous = pendingByAgent.get(auth.agentId);
      if (previous && previous.connectionId !== connectionId) {
        try {
          previous.ws.close(4000, "replaced");
        } catch {
          // ignore
        }
        unregisterConnection(previous);
      }
      pendingByAgent.set(auth.agentId, conn);
      publishLiveEvent({
        companyId: auth.companyId,
        type: "worker.link.connected",
        payload: { agentId: auth.agentId, linkMode: "agent_enrollment" },
      });
      logger.info({ connectionId, agentId: auth.agentId }, "worker link connected (agent enrollment)");
    } else if (auth.kind === "instance") {
      for (const aid of auth.boundAgentIds) {
        conn.agentIds.add(aid);
      }
      const prevInst = registryByInstance.get(auth.workerInstanceRowId);
      if (prevInst && prevInst.connectionId !== connectionId) {
        try {
          prevInst.ws.close(4000, "replaced");
        } catch {
          // ignore
        }
        unregisterConnection(prevInst);
      }
      registryByInstance.set(auth.workerInstanceRowId, conn);
      for (const aid of conn.agentIds) {
        agentToInstance.set(aid, auth.workerInstanceRowId);
      }
      void syncWorkerInstanceBindings(opts.db, auth.workerInstanceRowId).catch((err) => {
        logger.error({ err, workerInstanceRowId: auth.workerInstanceRowId }, "syncWorkerInstanceBindings failed");
      });
      void sendInstanceLinkTokenRefresh(
        ws,
        opts.mintInstanceLinkToken,
        auth.companyId,
        auth.workerInstanceRowId,
        connectionId,
      );
      void sendWorkerApiToken(ws, auth.companyId, auth.workerInstanceRowId, connectionId);
      publishLiveEvent({
        companyId: auth.companyId,
        type: "worker.link.connected",
        payload: { workerInstanceId: auth.workerInstanceRowId, linkMode: "instance" },
      });
      void touchWorkerInstanceLastSeenAt(opts.db, auth.companyId, auth.workerInstanceRowId).catch((err) => {
        logger.error({ err, workerInstanceRowId: auth.workerInstanceRowId }, "touchWorkerInstanceLastSeenAt failed");
      });
      logger.info(
        { connectionId, workerInstanceRowId: auth.workerInstanceRowId },
        "worker link connected (instance enrollment)",
      );
    } else {
      logger.info({ connectionId, companyId: auth.companyId }, "worker link connected (provision; awaiting hello)");
    }

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

    ws.on("close", () => {
      if (conn.connectionId === connectionId) {
        const { companyId: closedCompanyId, workerInstanceRowId: closedWi, primaryAgentId: closedAgentId } = conn;
        unregisterConnection(conn);
        if (closedWi) {
          publishLiveEvent({
            companyId: closedCompanyId,
            type: "worker.link.disconnected",
            payload: { workerInstanceId: closedWi },
          });
        } else if (closedAgentId) {
          publishLiveEvent({
            companyId: closedCompanyId,
            type: "worker.link.disconnected",
            payload: { agentId: closedAgentId, linkMode: "agent_enrollment" },
          });
        }
        logger.info({ connectionId }, "worker link disconnected");
      }
    });

    ws.on("error", (err: Error) => {
      logger.warn({ err, connectionId }, "worker link socket error");
    });
  });

  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (!req.url) {
      rejectUpgrade(socket, "400 Bad Request", "missing url");
      return;
    }

    const url = new URL(req.url, "http://localhost");
    if (url.pathname !== WORKER_LINK_PATH) {
      return;
    }

    const queryToken = url.searchParams.get("token")?.trim() ?? "";
    const authHeader = req.headers.authorization;
    const bearerToken =
      typeof authHeader === "string" && authHeader.toLowerCase().startsWith("bearer ")
        ? authHeader.slice(7).trim()
        : null;
    const token = bearerToken ?? (queryToken.length > 0 ? queryToken : null);

    if (!token) {
      rejectUpgrade(socket, "401 Unauthorized", "missing token");
      return;
    }

    const tokenHash = hashToken(token);

    void (async () => {
      try {
        const provisionCandidate = await opts.db
          .select({
            id: droneProvisioningTokens.id,
            companyId: droneProvisioningTokens.companyId,
          })
          .from(droneProvisioningTokens)
          .where(
            and(
              eq(droneProvisioningTokens.tokenHash, tokenHash),
              isNull(droneProvisioningTokens.consumedAt),
              gt(droneProvisioningTokens.expiresAt, new Date()),
            ),
          )
          .then((rows) => rows[0] ?? null);

        if (provisionCandidate) {
          const linkAuth: LinkAuth = {
            kind: "provision",
            companyId: provisionCandidate.companyId,
            provisioningTokenRowId: provisionCandidate.id,
          };
          wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
            wss.emit("connection", ws, req, linkAuth);
          });
          return;
        }

        const instanceEnrollment = await opts.db
          .select({
            id: workerInstanceLinkEnrollmentTokens.id,
            workerInstanceId: workerInstanceLinkEnrollmentTokens.workerInstanceId,
            companyId: workerInstanceLinkEnrollmentTokens.companyId,
          })
          .from(workerInstanceLinkEnrollmentTokens)
          .where(
            and(
              eq(workerInstanceLinkEnrollmentTokens.tokenHash, tokenHash),
              isNull(workerInstanceLinkEnrollmentTokens.consumedAt),
              gt(workerInstanceLinkEnrollmentTokens.expiresAt, new Date()),
            ),
          )
          .then((rows) => rows[0] ?? null);

        if (instanceEnrollment) {
          const boundRows = await opts.db
            .select({ agentId: workerInstanceAgents.agentId })
            .from(workerInstanceAgents)
            .where(eq(workerInstanceAgents.workerInstanceId, instanceEnrollment.workerInstanceId));

          const consumed = await opts.db
            .update(workerInstanceLinkEnrollmentTokens)
            .set({ consumedAt: new Date() })
            .where(
              and(
                eq(workerInstanceLinkEnrollmentTokens.id, instanceEnrollment.id),
                isNull(workerInstanceLinkEnrollmentTokens.consumedAt),
                gt(workerInstanceLinkEnrollmentTokens.expiresAt, new Date()),
              ),
            )
            .returning({ id: workerInstanceLinkEnrollmentTokens.id })
            .then((rows) => rows[0] ?? null);
          if (!consumed) {
            rejectUpgrade(socket, "401 Unauthorized", "invalid token");
            return;
          }

          const linkAuth: LinkAuth = {
            kind: "instance",
            workerInstanceRowId: instanceEnrollment.workerInstanceId,
            companyId: instanceEnrollment.companyId,
            boundAgentIds: boundRows.map((r) => r.agentId),
          };
          wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
            wss.emit("connection", ws, req, linkAuth);
          });
          return;
        }

        const enrollmentCandidate = await opts.db
          .select({
            id: managedWorkerLinkEnrollmentTokens.id,
            agentId: managedWorkerLinkEnrollmentTokens.agentId,
            companyId: managedWorkerLinkEnrollmentTokens.companyId,
          })
          .from(managedWorkerLinkEnrollmentTokens)
          .where(
            and(
              eq(managedWorkerLinkEnrollmentTokens.tokenHash, tokenHash),
              isNull(managedWorkerLinkEnrollmentTokens.consumedAt),
              gt(managedWorkerLinkEnrollmentTokens.expiresAt, new Date()),
            ),
          )
          .then((rows) => rows[0] ?? null);

        let agentId: string;
        let companyId: string;
        let enrollmentRowId: string | null = null;

        if (enrollmentCandidate) {
          agentId = enrollmentCandidate.agentId;
          companyId = enrollmentCandidate.companyId;
          enrollmentRowId = enrollmentCandidate.id;
        } else {
          const key = await opts.db
            .select()
            .from(agentApiKeys)
            .where(and(eq(agentApiKeys.keyHash, tokenHash), isNull(agentApiKeys.revokedAt)))
            .then((rows) => rows[0] ?? null);

          if (!key) {
            rejectUpgrade(socket, "401 Unauthorized", "invalid token");
            return;
          }

          await opts.db
            .update(agentApiKeys)
            .set({ lastUsedAt: new Date() })
            .where(eq(agentApiKeys.id, key.id));

          agentId = key.agentId;
          companyId = key.companyId;
        }

        const agentRecord = await opts.db
          .select()
          .from(agents)
          .where(eq(agents.id, agentId))
          .then((rows) => rows[0] ?? null);

        if (
          !agentRecord ||
          agentRecord.status === "terminated" ||
          agentRecord.status === "pending_approval"
        ) {
          rejectUpgrade(socket, "403 Forbidden", "agent not allowed");
          return;
        }

        if (enrollmentRowId) {
          const consumed = await opts.db
            .update(managedWorkerLinkEnrollmentTokens)
            .set({ consumedAt: new Date() })
            .where(
              and(
                eq(managedWorkerLinkEnrollmentTokens.id, enrollmentRowId),
                isNull(managedWorkerLinkEnrollmentTokens.consumedAt),
                gt(managedWorkerLinkEnrollmentTokens.expiresAt, new Date()),
              ),
            )
            .returning({ id: managedWorkerLinkEnrollmentTokens.id })
            .then((rows) => rows[0] ?? null);
          if (!consumed) {
            rejectUpgrade(socket, "401 Unauthorized", "invalid token");
            return;
          }
        }

        const linkAuth: LinkAuth = { kind: "agent", agentId, companyId };
        wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
          wss.emit("connection", ws, req, linkAuth);
        });
      } catch (err) {
        logger.error({ err, path: req.url }, "worker link upgrade failed");
        rejectUpgrade(socket, "500 Internal Server Error", "upgrade failed");
      }
    })();
  });
}

export function sendRunToWorker(
  agentId: string,
  message: {
    type: string;
    runId?: string;
    agentId?: string;
    adapterKey?: string;
    context?: unknown;
    /** OpenAI-style model id for model-gateway routing and cost attribution. */
    modelId?: string;
    placementId?: string;
    expectedWorkerInstanceId?: string;
  },
): boolean {
  const json = JSON.stringify(message);
  const inst = agentToInstance.get(agentId);
  if (inst) {
    if (trySendJsonToWorkerInstance(inst, json)) return true;
    publishWorkerInstanceDeliver(inst, json);
    return isWorkerDeliveryRedisConfigured();
  }
  const pending = pendingByAgent.get(agentId);
  if (pending) {
    return trySendJsonOnConnection(pending, json);
  }
  return false;
}

export function sendCancelToWorker(agentId: string, runId: string): boolean {
  return sendRunToWorker(agentId, { type: "cancel", runId });
}

export function isAgentWorkerConnected(agentId: string): boolean {
  const c = findConnectionForAgent(agentId);
  if (!c) return false;
  return c.ws.readyState === WebSocket.OPEN;
}

export function getWorkerLinkStableInstanceId(agentId: string): string | undefined {
  const c = findConnectionForAgent(agentId);
  return c?.stableInstanceId;
}

export function getConnectedManagedWorkerAgentIdsForCompany(companyId: string): string[] {
  const ids = new Set<string>();
  for (const conn of registryByInstance.values()) {
    if (conn.companyId === companyId && conn.ws.readyState === WebSocket.OPEN) {
      for (const aid of conn.agentIds) {
        ids.add(aid);
      }
    }
  }
  for (const [aid, conn] of pendingByAgent) {
    if (conn.companyId === companyId && conn.ws.readyState === WebSocket.OPEN) {
      ids.add(aid);
    }
  }
  return [...ids];
}

/** True when this process has an open WebSocket for the worker instance row (drone link). */
export function isWorkerInstanceConnected(workerInstanceRowId: string, companyId: string): boolean {
  const c = registryByInstance.get(workerInstanceRowId);
  if (!c || c.companyId !== companyId) return false;
  return c.ws.readyState === WebSocket.OPEN;
}
