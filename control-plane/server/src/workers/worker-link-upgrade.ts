import type { IncomingMessage, Server as HttpServer } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
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
import { touchWorkerInstanceLastSeenAt } from "./worker-hello.js";
import type { LinkAuth, WorkerLinkAttachOpts } from "./worker-link-types.js";
import {
  WORKER_LINK_PATH,
  hashToken,
  rejectUpgrade,
  sendInstanceLinkTokenRefresh,
  sendWorkerApiToken,
} from "./worker-link-internal.js";
import { resolveWorkerLinkUpgradeAuth } from "./worker-link-upgrade-auth.js";
import { attachWorkerLinkMessageHandler } from "./worker-link-messages.js";

let connectionIdCounter = 0;

export function attachWorkerLinkUpgrade(
  server: HttpServer,
  opts: WorkerLinkAttachOpts,
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

    attachWorkerLinkMessageHandler(ws, connectionId, conn, auth, opts);

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
        const resolved = await resolveWorkerLinkUpgradeAuth(opts.db, tokenHash);
        if (!resolved.ok) {
          rejectUpgrade(socket, resolved.statusLine, resolved.message);
          return;
        }
        const linkAuth: LinkAuth = resolved.auth;
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
