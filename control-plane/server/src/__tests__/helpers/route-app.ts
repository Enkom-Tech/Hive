import express, { type Router } from "express";
import Fastify, { type FastifyInstance, type FastifyPlugin } from "fastify";
import type { Principal } from "@hive/shared";
import { LOCAL_BOARD_USER_ID } from "../../board-claim.js";
import { errorHandler } from "../../middleware/error-handler.js";
import { HttpError } from "../../errors.js";
import { ZodError } from "zod";

export type BoardPrincipalOpts = {
  id?: string;
  companyIds: string[];
  isSystem?: boolean;
  isInstanceAdmin?: boolean;
};

export type AgentPrincipalOpts = {
  agentId: string;
  companyId: string;
  runId?: string;
};

export type WorkerInstancePrincipalOpts = {
  workerInstanceRowId: string;
  companyId: string;
};

/** Build a board principal (user or system) for tests. */
export function principalBoard(opts: BoardPrincipalOpts): Principal {
  if (opts.isSystem) {
    return {
      type: "system",
      id: opts.id ?? "local-board",
      roles: opts.isInstanceAdmin ? ["instance_admin"] : [],
    };
  }
  return {
    type: "user",
    id: opts.id ?? LOCAL_BOARD_USER_ID,
    company_ids: opts.companyIds,
    roles: opts.isInstanceAdmin ? ["instance_admin"] : [],
  };
}

/** Build an agent principal for tests. */
export function principalAgent(opts: AgentPrincipalOpts): Principal {
  return {
    type: "agent",
    id: opts.agentId,
    company_id: opts.companyId,
    roles: [],
    ...(opts.runId ? { runId: opts.runId } : {}),
  };
}

/** Worker-instance principal (drone JWT) for tests. */
export function principalWorkerInstance(opts: WorkerInstancePrincipalOpts): Principal {
  const id = opts.workerInstanceRowId;
  return {
    type: "worker_instance",
    id,
    company_id: opts.companyId,
    workerInstanceRowId: id,
    roles: [],
  };
}

export type TestPrincipal = Principal | null;

export interface RouteTestAppOptions {
  /** Router to mount at /api (e.g. projectRoutes(db)) */
  router: Router;
  /** Principal to inject; defaults to board user with companyIds ["company-1"] */
  principal?: TestPrincipal;
}

const defaultPrincipal: Principal = principalBoard({
  companyIds: ["company-1"],
  isSystem: false,
  isInstanceAdmin: false,
});

export function createRouteTestApp(options: RouteTestAppOptions): express.Express {
  const { router, principal = defaultPrincipal } = options;
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as express.Request & { principal: Principal | null }).principal = principal;
    next();
  });
  app.use("/api", router);
  app.use(errorHandler);
  return app;
}

/** @deprecated Use principalBoard. */
export function actorBoard(
  companyIds: string[],
  overrides?: Partial<Omit<BoardPrincipalOpts, "companyIds">> & { source?: "session" | "local_implicit" },
): Principal {
  const isSystem = overrides?.source === "local_implicit" || overrides?.isSystem;
  const explicitSession = overrides?.source === "session";
  const id =
    overrides?.id ??
    (isSystem ? undefined : explicitSession ? "user-1" : LOCAL_BOARD_USER_ID);
  return principalBoard({
    companyIds,
    isSystem: Boolean(isSystem),
    ...overrides,
    id,
  });
}

/** @deprecated Use principalAgent. */
export function actorAgent(companyId: string, agentId = "agent-1", _overrides?: unknown): Principal {
  return principalAgent({ agentId, companyId });
}

/** No principal (unauthenticated). */
export function principalNone(): null {
  return null;
}

/** @deprecated Use principalNone. */
export function actorNone(): null {
  return principalNone();
}

// ─── Fastify test helper ───────────────────────────────────────────────────────

export interface FastifyRouteTestOptions {
  /**
   * A Fastify plugin (async function taking a FastifyInstance) to mount at /api.
   * The plugin must be a valid Fastify plugin decorated with fastify-plugin or
   * registered via fastify.register().
   */
  plugin: FastifyPlugin;
  /** Principal to inject; defaults to board user with companyIds ["company-1"] */
  principal?: TestPrincipal;
}

/**
 * Creates a minimal Fastify instance for route tests.
 *
 * Usage:
 * ```ts
 * const app = await createRouteTestFastify({ plugin: healthPlugin });
 * const res = await app.inject({ method: "GET", url: "/api/health" });
 * expect(res.statusCode).toBe(200);
 * await app.close();
 * ```
 */
export async function createRouteTestFastify(options: FastifyRouteTestOptions): Promise<FastifyInstance> {
  const { plugin, principal = defaultPrincipal } = options;

  const fastify = Fastify({ logger: false });

  // Inject principal on every request
  fastify.addHook("onRequest", async (req) => {
    req.principal = principal;
  });

  // Error handler matching Express error-handler semantics
  fastify.setErrorHandler((err, _req, reply) => {
    if (err instanceof HttpError) {
      void reply.status(err.status).send({
        error: err.message,
        ...(err.details ? { details: err.details } : {}),
      });
      return;
    }
    if (err instanceof ZodError) {
      void reply.status(400).send({ error: "Validation error", details: err.issues });
      return;
    }
    void reply.status(500).send({ error: "Internal server error" });
  });

  await fastify.register(plugin, { prefix: "/api" });
  await fastify.ready();
  return fastify;
}
