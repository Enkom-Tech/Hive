import type { Request, Response } from "express";
import { Readable } from "node:stream";
import { z } from "zod";
import type { Db } from "@hive/db";
import type { DeploymentMode } from "@hive/shared";

const companyEventsSSEQuerySchema = z.object({
  token: z.string().optional(),
});
import type { BetterAuthSessionResult } from "../auth/better-auth.js";
import { authorizeCompanyEventsAccess } from "../realtime/company-events-auth.js";
import { subscribeCompanyLiveEvents } from "../services/live-events.js";

const HEARTBEAT_INTERVAL_MS = 30_000;

function parseBearerToken(rawAuth: string | string[] | undefined): string | null {
  const auth = Array.isArray(rawAuth) ? rawAuth[0] : rawAuth;
  if (!auth) return null;
  if (!auth.toLowerCase().startsWith("bearer ")) return null;
  const token = auth.slice("bearer ".length).trim();
  return token.length > 0 ? token : null;
}

export interface CreateCompanyEventsSSEHandlerOpts {
  deploymentMode: DeploymentMode;
  resolveSession?: (req: Request) => Promise<BetterAuthSessionResult | null>;
}

export function createCompanyEventsSSEHandler(
  db: Db,
  opts: CreateCompanyEventsSSEHandlerOpts,
): (req: Request, res: Response) => void {
  return async (req: Request, res: Response) => {
    const companyId = req.params.companyId as string;
    if (!companyId) {
      res.status(400).json({ error: "Missing companyId" });
      return;
    }

    const parsed = companyEventsSSEQuerySchema.safeParse(req.query);
    const queryToken = parsed.success && typeof parsed.data.token === "string"
      ? parsed.data.token.trim()
      : null;
    const authToken = parseBearerToken(req.headers.authorization);
    const token = authToken ?? (queryToken && queryToken.length > 0 ? queryToken : null);

    const session = opts.resolveSession ? await opts.resolveSession(req) : null;
    const sessionUserId = session?.user?.id ?? null;

    const context = await authorizeCompanyEventsAccess(db, companyId, {
      deploymentMode: opts.deploymentMode,
      token,
      sessionUserId,
    });

    if (!context) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }

    const encoder = new TextEncoder();
    let cleanup: (() => void) | null = null;

    const stream = new ReadableStream({
      start(controller) {
        try {
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ type: "connected", data: null, timestamp: Date.now() })}\n\n`,
            ),
          );
        } catch {
          // Client may have disconnected
        }

        const handler = (event: {
          id: number;
          companyId: string;
          type: string;
          createdAt: string;
          payload: Record<string, unknown>;
        }) => {
          try {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
          } catch {
            // Client disconnected
          }
        };

        const unsubscribe = subscribeCompanyLiveEvents(context.companyId, handler);

        const heartbeat = setInterval(() => {
          try {
            controller.enqueue(encoder.encode(": heartbeat\n\n"));
          } catch {
            clearInterval(heartbeat);
          }
        }, HEARTBEAT_INTERVAL_MS);

        cleanup = () => {
          unsubscribe();
          clearInterval(heartbeat);
        };
      },

      cancel() {
        if (cleanup) cleanup();
      },
    });

    const headers: Record<string, string> = {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    };
    res.writeHead(200, headers);
    Readable.fromWeb(stream as import("node:stream/web").ReadableStream).pipe(res);
  };
}
