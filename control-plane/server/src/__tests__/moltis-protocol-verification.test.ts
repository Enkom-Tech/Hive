/**
 * Optional Moltis protocol verification test.
 * Runs only when MOLTIS_WS_URL is set (e.g. ws://127.0.0.1:PORT/ws/chat).
 * Auth: MOLTIS_WS_TOKEN or MOLTIS_WS_AUTH (Bearer). If unset, test is skipped.
 * Not required for default pnpm test:run.
 */
import { describe, expect, it } from "vitest";
import { WebSocket } from "ws";

const MOLTIS_WS_URL = process.env.MOLTIS_WS_URL;
const MOLTIS_WS_TOKEN = process.env.MOLTIS_WS_TOKEN ?? process.env.MOLTIS_WS_AUTH;

describe("Moltis protocol verification (optional)", () => {
  it("client-first connect with protocol 4 when MOLTIS_WS_URL is set", async () => {
    if (!MOLTIS_WS_URL || !MOLTIS_WS_TOKEN?.trim()) {
      return; // skip when env not set
    }

    const token = MOLTIS_WS_TOKEN.trim();
    const authHeader = token.toLowerCase().startsWith("bearer ") ? token : `Bearer ${token}`;

    const ws = new WebSocket(MOLTIS_WS_URL, {
      headers: {
        Authorization: authHeader,
      },
    });

    const openPromise = new Promise<void>((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
      ws.once("close", (code, reason) =>
        reject(new Error(`closed before open: ${code} ${reason.toString()}`)),
      );
    });

    await expect(openPromise).resolves.toBeUndefined();

    const firstResponsePromise = new Promise<{ ok: boolean; payload?: { protocol?: number } }>(
      (resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("timeout waiting for connect response")), 10_000);
        ws.once("message", (data) => {
          clearTimeout(timeout);
          try {
            const frame = JSON.parse(Buffer.isBuffer(data) ? data.toString("utf8") : String(data));
            if (frame.type === "res" && frame.id === "connect-1") {
              resolve({ ok: frame.ok, payload: frame.payload });
            } else {
              resolve({ ok: false, payload: frame.payload });
            }
          } catch (e) {
            reject(e);
          }
        });
      },
    );

    // Client-first: send connect immediately (no waiting for connect.challenge)
    const connectParams = {
      minProtocol: 4,
      maxProtocol: 4,
      client: {
        id: "hive-moltis-verification",
        version: "test",
        platform: process.platform,
        mode: "backend",
      },
      role: "operator",
      scopes: ["operator.admin"],
      auth: { token: MOLTIS_WS_TOKEN.replace(/^bearer\s+/i, "").trim() },
    };

    ws.send(
      JSON.stringify({
        type: "req",
        id: "connect-1",
        method: "connect",
        params: connectParams,
      }),
    );

    const result = await firstResponsePromise;
    ws.close(1000, "test-done");

    expect(result.ok).toBe(true);
    expect(result.payload?.protocol).toBe(4);
  });
});
