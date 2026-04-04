import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { boardMutationGuard } from "../middleware/board-mutation-guard.js";

async function createApp(
  actorType: "board" | "agent",
  boardSource: "session" | "local_implicit" = "session",
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  app.addHook("onRequest", async (req) => {
    req.principal =
      actorType === "board"
        ? boardSource === "local_implicit"
          ? { type: "system", id: "local-board", roles: [] }
          : { type: "user", id: "board", company_ids: [], roles: [] }
        : { type: "agent", id: "agent-1", company_id: "company-1", roles: [] };
  });

  // Register the Node middleware as a Fastify preHandler via addHook.
  // The guard reads principal from the raw IncomingMessage, so we must
  // propagate it from the Fastify request decoration before calling the guard.
  const guard = boardMutationGuard();
  app.addHook("preHandler", (req, reply, done) => {
    (req.raw as typeof req.raw & { principal?: typeof req.principal }).principal = req.principal;
    guard(req.raw, reply.raw, done);
  });

  app.post("/mutate", async (_req, reply) => reply.status(204).send());
  app.get("/read", async (_req, reply) => reply.status(204).send());

  await app.ready();
  return app;
}

describe("boardMutationGuard", () => {
  it("allows safe methods for board actor", async () => {
    const app = await createApp("board");
    const res = await app.inject({ method: "GET", url: "/read" });
    expect(res.statusCode).toBe(204);
    await app.close();
  });

  it("blocks board mutations without trusted origin", async () => {
    const app = await createApp("board");
    const res = await app.inject({ method: "POST", url: "/mutate", payload: { ok: true } });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "Board mutation requires trusted browser origin" });
    await app.close();
  });

  it("allows local implicit board mutations without origin", async () => {
    const app = await createApp("board", "local_implicit");
    const res = await app.inject({ method: "POST", url: "/mutate", payload: { ok: true } });
    expect(res.statusCode).toBe(204);
    await app.close();
  });

  it("allows board mutations from trusted origin", async () => {
    const app = await createApp("board");
    const res = await app.inject({
      method: "POST",
      url: "/mutate",
      headers: { origin: "http://localhost:3100" },
      payload: { ok: true },
    });
    expect(res.statusCode).toBe(204);
    await app.close();
  });

  it("allows board mutations from trusted referer origin", async () => {
    const app = await createApp("board");
    const res = await app.inject({
      method: "POST",
      url: "/mutate",
      headers: { referer: "http://localhost:3100/issues/abc" },
      payload: { ok: true },
    });
    expect(res.statusCode).toBe(204);
    await app.close();
  });

  it("does not block authenticated agent mutations", async () => {
    const app = await createApp("agent");
    const res = await app.inject({ method: "POST", url: "/mutate", payload: { ok: true } });
    expect(res.statusCode).toBe(204);
    await app.close();
  });
});
