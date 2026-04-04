import { z } from "zod";
import type { Db } from "@hive/db";
import type { DeploymentMode } from "@hive/shared";
import type { FastifyInstance } from "fastify";

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

export interface CompanyEventsSSEPluginOpts {
  db: Db;
  deploymentMode: DeploymentMode;
  resolveSessionFromHeaders?: (headers: Headers) => Promise<BetterAuthSessionResult | null>;
}

/**
 * Fastify-native company events SSE plugin.
 *
 * Rewrites the Express ReadableStream/res.writeHead approach to use
 * reply.raw directly — Fastify's recommended pattern for hijacking the
 * socket for streaming responses.  A heartbeat comment is sent every 30 s
 * to keep proxies from closing idle connections.
 */
export async function companyEventsSSEPlugin(
  fastify: FastifyInstance,
  opts: CompanyEventsSSEPluginOpts,
): Promise<void> {
  fastify.get<{
    Params: { companyId: string };
    Querystring: { token?: string };
  }>(
    "/api/companies/:companyId/events",
    async (req, reply) => {
      const { companyId } = req.params;

      const parsed = companyEventsSSEQuerySchema.safeParse(req.query);
      const queryToken = parsed.success && typeof parsed.data.token === "string"
        ? parsed.data.token.trim()
        : null;
      const authToken = parseBearerToken(req.headers.authorization as string | undefined);
      const token = authToken ?? (queryToken && queryToken.length > 0 ? queryToken : null);

      let sessionUserId: string | null = null;
      if (opts.resolveSessionFromHeaders) {
        const fetchHeaders = new Headers();
        for (const [k, v] of Object.entries(req.headers)) {
          if (!v) continue;
          if (Array.isArray(v)) {
            for (const item of v) fetchHeaders.append(k, item);
          } else {
            fetchHeaders.set(k, v);
          }
        }
        const session = await opts.resolveSessionFromHeaders(fetchHeaders);
        sessionUserId = session?.user?.id ?? null;
      }

      const context = await authorizeCompanyEventsAccess(opts.db, companyId, {
        deploymentMode: opts.deploymentMode,
        token,
        sessionUserId,
      });

      if (!context) {
        return reply.status(403).send({ error: "Forbidden" });
      }

      // Hijack the socket: write SSE headers then stream events directly to the
      // raw Node response. Fastify's reply pipeline is bypassed from this point.
      const raw = reply.raw;
      raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });

      const enc = (s: string) => s;

      const sendLine = (line: string): boolean => {
        try {
          return raw.write(enc(line));
        } catch {
          return false;
        }
      };

      sendLine(`data: ${JSON.stringify({ type: "connected", data: null, timestamp: Date.now() })}\n\n`);

      const handler = (event: {
        id: number;
        companyId: string;
        type: string;
        createdAt: string;
        payload: Record<string, unknown>;
      }) => {
        sendLine(`data: ${JSON.stringify(event)}\n\n`);
      };

      const unsubscribe = subscribeCompanyLiveEvents(context.companyId, handler);

      const heartbeat = setInterval(() => {
        if (!sendLine(": heartbeat\n\n")) {
          cleanup();
        }
      }, HEARTBEAT_INTERVAL_MS);

      function cleanup() {
        unsubscribe();
        clearInterval(heartbeat);
        try {
          raw.end();
        } catch {
          // socket already closed
        }
      }

      raw.on("close", cleanup);
      raw.on("error", cleanup);

      // Signal to Fastify that the reply has been manually handled so it does
      // not try to send its own response after the handler returns.
      await reply.hijack();
    },
  );
}
