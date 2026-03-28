import { createHash } from "node:crypto";
import type { Duplex } from "node:stream";
import { WebSocket } from "ws";
import { logger } from "../middleware/logger.js";
import { mintWorkerApiToken } from "../auth/worker-jwt.js";
import type { MintInstanceLinkToken } from "./worker-link-types.js";

export const WORKER_LINK_PATH = "/api/workers/link";

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function rejectUpgrade(socket: Duplex, statusLine: string, message: string) {
  const safe = message.replace(/[\r\n]+/g, " ").trim();
  socket.write(
    `HTTP/1.1 ${statusLine}\r\nConnection: close\r\nContent-Type: text/plain\r\n\r\n${safe}`,
  );
  socket.destroy();
}

export async function sendInstanceLinkTokenRefresh(
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

export async function sendWorkerApiToken(
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
