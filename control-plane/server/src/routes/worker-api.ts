import { Router, type NextFunction, type Request, type Response } from "express";
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@hive/db";
import { agents, workerApiIdempotency } from "@hive/db";
import {
  createAgentHireSchema,
  createCostEventSchema,
  createIssueSchema,
  ISSUE_STATUSES,
  ISSUE_STATUS_BACKLOG,
  ISSUE_STATUS_IN_PROGRESS,
  ISSUE_STATUSES_CLOSED,
} from "@hive/shared";
import { z } from "zod";
import {
  costService,
  createOrFoldIntent,
  deliverWorkAvailable,
  heartbeatService,
  insertIntentLink,
  issueService,
  logActivity,
  publishLiveEvent,
  WORKABLE_STATUSES_FOR_WEBHOOK,
} from "../services/index.js";
import { validate } from "../middleware/validate.js";
import { assertWorkerInstance, getWorkerApiActorInfo } from "./authz.js";
import { forbidden, HttpError } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { runWorkerApiAgentHire } from "./worker-api-agent-hire.js";
import {
  assertWorkerAgentCanAssignTasks,
  assertWorkerAgentCanCreateAgents,
  assertWorkerIssueDepartmentConstraints,
} from "./worker-api-issue-helpers.js";
import {
  parseWorkerApiIdempotencyKey,
  WORKER_API_IDEMPOTENCY_ROUTES,
  workerApiIdempotencyAdvisoryKeys,
} from "./worker-api-idempotency.js";
import {
  adaptReplayedWorkerApiBody,
  buildWorkerApiSuccessResponse,
  workerApiSuccessJsonBody,
} from "./worker-api-payload.js";
import { listPluginToolCatalogForCompany } from "../services/plugin-tools.js";

export const WORKER_API_ACTIONS = {
  costReport: "worker_api.cost_report",
  issueAppendComment: "worker_api.issue_append_comment",
  issueTransitionStatus: "worker_api.issue_transition_status",
  issueGet: "worker_api.issue_get",
  issueCreate: "worker_api.issue_create",
  issueUpdate: "worker_api.issue_update",
} as const;

const workerCostReportSchema = createCostEventSchema.and(
  z.object({
    agentId: z.string().uuid(),
  }),
);

const workerCreateIssueSchema = createIssueSchema.and(
  z.object({
    agentId: z.string().uuid(),
  }),
);

const workerIssuePatchSchema = z
  .object({
    agentId: z.string().uuid(),
    title: createIssueSchema.shape.title.optional(),
    description: z.string().optional().nullable(),
    priority: createIssueSchema.shape.priority.optional(),
    projectId: z.string().uuid().optional().nullable(),
    goalId: z.string().uuid().optional().nullable(),
    departmentId: z.string().uuid().optional().nullable(),
    parentId: z.string().uuid().optional().nullable(),
    assigneeAgentId: z.string().uuid().optional().nullable(),
    assigneeUserId: z.string().optional().nullable(),
    billingCode: z.string().optional().nullable(),
    requiresQualityReview: z.boolean().optional().nullable(),
    assigneeAdapterOverrides: createIssueSchema.shape.assigneeAdapterOverrides,
    executionWorkspaceSettings: createIssueSchema.shape.executionWorkspaceSettings,
    labelIds: z.array(z.string().uuid()).optional(),
  })
  .strict();

const workerAgentHireSchema = createAgentHireSchema.extend({
  agentId: z.string().uuid(),
});

const issueAppendBodySchema = z.object({
  agentId: z.string().uuid(),
  body: z.string().min(1).max(256_000),
});

const issueStatuses = ISSUE_STATUSES as readonly string[];

const pluginToolsQuerySchema = z.object({
  agentId: z.string().uuid(),
});

const issueTransitionBodySchema = z.object({
  agentId: z.string().uuid(),
  status: z
    .string()
    .min(1)
    .refine((s) => issueStatuses.includes(s), { message: "Invalid issue status" }),
});

const issueGetQuerySchema = z.object({
  agentId: z.string().uuid(),
});

async function requireAgentInCompany(db: Db, agentId: string, companyId: string): Promise<void> {
  const row = await db
    .select({ id: agents.id, status: agents.status })
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.companyId, companyId)))
    .then((r) => r[0] ?? null);
  if (!row || row.status === "terminated" || row.status === "pending_approval") {
    throw forbidden("Agent not in company or not allowed");
  }
}

async function resolveIssueParam(issuesSvc: ReturnType<typeof issueService>, issueIdParam: string) {
  let issue = await issuesSvc.getById(issueIdParam);
  if (!issue && /^[A-Z]+-\d+$/i.test(issueIdParam.trim())) {
    issue = await issuesSvc.getByIdentifier(issueIdParam.trim());
  }
  return issue;
}

export function workerApiRoutes(db: Db, opts: { secretsStrictMode: boolean }): Router {
  const router = Router();
  const strictSecretsMode = opts.secretsStrictMode;
  const costs = costService(db);
  const issues = issueService(db);
  const heartbeat = heartbeatService(db);

  router.post(
    "/issues",
    validate(workerCreateIssueSchema),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { companyId } = assertWorkerInstance(req);
        const body = req.body as z.infer<typeof workerCreateIssueSchema>;
        const { agentId, ...issueInput } = body;
        await requireAgentInCompany(db, agentId, companyId);

        if (issueInput.assigneeAgentId || issueInput.assigneeUserId) {
          await assertWorkerAgentCanAssignTasks(db, companyId, agentId);
        }
        await assertWorkerIssueDepartmentConstraints(db, companyId, agentId, {
          departmentId: issueInput.departmentId,
          assigneeAgentId: issueInput.assigneeAgentId,
          assigneeUserId: issueInput.assigneeUserId,
        });

        await issues.validateIssueCreateAssignees(companyId, {
          assigneeAgentId: issueInput.assigneeAgentId,
          assigneeUserId: issueInput.assigneeUserId,
          status: issueInput.status ?? "backlog",
        });

        const actor = getWorkerApiActorInfo(req, agentId);
        const rawText =
          [issueInput.title, issueInput.description].filter(Boolean).join("\n") || issueInput.title || "";

        const idempotencyKey = parseWorkerApiIdempotencyKey(req);

        const emitWorkerIssueCreateSideEffects = async (
          issue: Awaited<ReturnType<typeof issues.createInTx>>,
          intentResult: Awaited<ReturnType<typeof createOrFoldIntent>>,
        ) => {
          await logActivity(db, {
            companyId,
            actorType: actor.actorType,
            actorId: actor.actorId,
            agentId: actor.agentId,
            runId: actor.runId,
            action: WORKER_API_ACTIONS.issueCreate,
            entityType: "issue",
            entityId: issue.id,
            details: { title: issue.title, identifier: issue.identifier, workerApi: true },
          });

          await logActivity(db, {
            companyId,
            actorType: actor.actorType,
            actorId: actor.actorId,
            agentId: actor.agentId,
            runId: actor.runId,
            action: intentResult.folded ? "intent.folded_into_existing" : "intent.created",
            entityType: "intent",
            entityId: intentResult.intentId,
            details: {
              canonicalKey: intentResult.canonicalKey,
              folded: intentResult.folded,
              issueId: issue.id,
              workerApi: true,
            },
          });

          publishLiveEvent({
            companyId,
            type: intentResult.folded ? "intent.folded" : "intent.created",
            payload: {
              intentId: intentResult.intentId,
              canonicalKey: intentResult.canonicalKey,
              folded: intentResult.folded,
              issueId: issue.id,
              linkType: intentResult.folded ? "duplicate" : "primary",
            },
          });

          if (issue.assigneeAgentId && issue.status !== ISSUE_STATUS_BACKLOG) {
            void heartbeat
              .wakeup(issue.assigneeAgentId, {
                source: "assignment",
                triggerDetail: "system",
                reason: "issue_assigned",
                payload: { issueId: issue.id, mutation: "create" },
                requestedByActorType: actor.actorType,
                requestedByActorId: actor.actorId,
                contextSnapshot: { issueId: issue.id, source: "issue.create" },
              })
              .catch((err) => logger.warn({ err, issueId: issue.id }, "failed to wake assignee on worker issue create"));
          }
          if (
            issue.assigneeAgentId &&
            (WORKABLE_STATUSES_FOR_WEBHOOK as readonly string[]).includes(issue.status)
          ) {
            void deliverWorkAvailable(issue.assigneeAgentId, issue.companyId, issue.id, db).catch((err) =>
              logger.warn({ err, issueId: issue.id, agentId: issue.assigneeAgentId }, "work_available webhook failed"),
            );
          }
        };

        if (!idempotencyKey) {
          const { issue, intentResult } = await db.transaction(async (tx) => {
            const intentRes = await createOrFoldIntent(tx, {
              companyId,
              rawText,
              source: "agent",
              intentType: "create_issue",
              projectId: issueInput.projectId ?? null,
              goalId: issueInput.goalId ?? null,
            });
            const created = await issues.createInTx(tx, companyId, {
              ...issueInput,
              createdByAgentId: agentId,
              createdByUserId: null,
            });
            await insertIntentLink(tx, {
              intentId: intentRes.intentId,
              companyId,
              entityType: "issue",
              entityId: created.id,
              linkType: intentRes.folded ? "duplicate" : "primary",
            });
            return { issue: created, intentResult: intentRes };
          });
          await emitWorkerIssueCreateSideEffects(issue, intentResult);
          res.status(201).json(buildWorkerApiSuccessResponse(req, { issue }));
          return;
        }

        const route = WORKER_API_IDEMPOTENCY_ROUTES.issueCreate;
        const [lockK1, lockK2] = workerApiIdempotencyAdvisoryKeys(companyId, agentId, route, idempotencyKey);

        const txResult = await db.transaction(async (tx) => {
          await tx.execute(sql`select pg_advisory_xact_lock(${lockK1}, ${lockK2})`);
          const cached = await tx
            .select({
              httpStatus: workerApiIdempotency.httpStatus,
              responseBody: workerApiIdempotency.responseBody,
            })
            .from(workerApiIdempotency)
            .where(
              and(
                eq(workerApiIdempotency.companyId, companyId),
                eq(workerApiIdempotency.agentId, agentId),
                eq(workerApiIdempotency.route, route),
                eq(workerApiIdempotency.idempotencyKey, idempotencyKey),
              ),
            )
            .limit(1)
            .then((rows) => rows[0] ?? null);
          if (cached) {
            return { kind: "replay" as const, httpStatus: cached.httpStatus, body: cached.responseBody };
          }

          const intentRes = await createOrFoldIntent(tx, {
            companyId,
            rawText,
            source: "agent",
            intentType: "create_issue",
            projectId: issueInput.projectId ?? null,
            goalId: issueInput.goalId ?? null,
          });
          const created = await issues.createInTx(tx, companyId, {
            ...issueInput,
            createdByAgentId: agentId,
            createdByUserId: null,
          });
          await insertIntentLink(tx, {
            intentId: intentRes.intentId,
            companyId,
            entityType: "issue",
            entityId: created.id,
            linkType: intentRes.folded ? "duplicate" : "primary",
          });
          const responseBody = JSON.parse(JSON.stringify(workerApiSuccessJsonBody({ issue: created }))) as Record<
            string,
            unknown
          >;
          await tx.insert(workerApiIdempotency).values({
            companyId,
            agentId,
            route,
            idempotencyKey,
            httpStatus: 201,
            responseBody,
          });
          return {
            kind: "fresh" as const,
            issue: created,
            intentResult: intentRes,
            body: responseBody,
          };
        });

        if (txResult.kind === "replay") {
          res.status(txResult.httpStatus).json(adaptReplayedWorkerApiBody(req, txResult.body));
          return;
        }

        await emitWorkerIssueCreateSideEffects(txResult.issue, txResult.intentResult);
        res.status(201).json(buildWorkerApiSuccessResponse(req, (txResult.body as { result: unknown }).result));
      } catch (err) {
        next(err);
      }
    },
  );

  router.patch(
    "/issues/:issueId",
    validate(workerIssuePatchSchema),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { companyId } = assertWorkerInstance(req);
        const issueIdParam = req.params.issueId as string;
        const body = req.body as z.infer<typeof workerIssuePatchSchema>;
        const { agentId, ...patchRest } = body;
        await requireAgentInCompany(db, agentId, companyId);

        const existing = await resolveIssueParam(issues, issueIdParam);
        if (!existing) {
          res.status(404).json({ error: "Issue not found" });
          return;
        }
        if (existing.companyId !== companyId) {
          res.status(403).json({ error: "Forbidden" });
          return;
        }

        const assigneeWillChange =
          (patchRest.assigneeAgentId !== undefined && patchRest.assigneeAgentId !== existing.assigneeAgentId) ||
          (patchRest.assigneeUserId !== undefined && patchRest.assigneeUserId !== existing.assigneeUserId);

        const isAgentReturningIssueToCreator =
          existing.assigneeAgentId === agentId &&
          patchRest.assigneeAgentId === null &&
          typeof patchRest.assigneeUserId === "string" &&
          !!existing.createdByUserId &&
          patchRest.assigneeUserId === existing.createdByUserId;

        if (assigneeWillChange && !isAgentReturningIssueToCreator) {
          await assertWorkerAgentCanAssignTasks(db, companyId, agentId);
        }
        await assertWorkerIssueDepartmentConstraints(db, companyId, agentId, {
          departmentId:
            patchRest.departmentId === undefined ? existing.departmentId : patchRest.departmentId,
          assigneeAgentId:
            patchRest.assigneeAgentId === undefined ? existing.assigneeAgentId : patchRest.assigneeAgentId,
          assigneeUserId:
            patchRest.assigneeUserId === undefined ? existing.assigneeUserId : patchRest.assigneeUserId,
        });

        if (existing.status === ISSUE_STATUS_IN_PROGRESS && existing.assigneeAgentId === agentId) {
          const runId = req.header("x-hive-run-id")?.trim();
          if (!runId) {
            res.status(401).json({ error: "Agent run id required for checked-out issue" });
            return;
          }
          await issues.assertCheckoutOwner(existing.id, agentId, runId);
        }

        let issue;
        try {
          issue = await issues.update(existing.id, patchRest);
        } catch (err) {
          if (err instanceof HttpError && err.status === 422) {
            logger.warn({ issueId: existing.id, companyId, err: err.message }, "worker issue update rejected");
          }
          throw err;
        }
        if (!issue) {
          res.status(404).json({ error: "Issue not found" });
          return;
        }

        const movedToClosed =
          (ISSUE_STATUSES_CLOSED as readonly string[]).includes(issue.status) &&
          !(ISSUE_STATUSES_CLOSED as readonly string[]).includes(existing.status);
        const closedTerminal =
          issue.status === "done" || issue.status === "cancelled" ? issue.status : null;
        if (movedToClosed && existing.executionRunId && closedTerminal) {
          void heartbeat
            .finishRunForIssueClosure(existing.executionRunId, closedTerminal)
            .catch((err) => logger.warn({ err, runId: existing.executionRunId }, "finish run for issue closure failed"));
        }
        if (
          issue.assigneeAgentId &&
          (WORKABLE_STATUSES_FOR_WEBHOOK as readonly string[]).includes(issue.status)
        ) {
          void deliverWorkAvailable(issue.assigneeAgentId, issue.companyId, issue.id, db).catch((err) =>
            logger.warn({ err, issueId: issue.id }, "work_available webhook failed"),
          );
        }

        const previous: Record<string, unknown> = {};
        for (const key of Object.keys(patchRest)) {
          if (key in existing && (existing as Record<string, unknown>)[key] !== (patchRest as Record<string, unknown>)[key]) {
            previous[key] = (existing as Record<string, unknown>)[key];
          }
        }
        const actor = getWorkerApiActorInfo(req, agentId);
        await logActivity(db, {
          companyId,
          actorType: actor.actorType,
          actorId: actor.actorId,
          agentId: actor.agentId,
          runId: actor.runId,
          action: WORKER_API_ACTIONS.issueUpdate,
          entityType: "issue",
          entityId: issue.id,
          details: {
            ...patchRest,
            identifier: issue.identifier,
            workerApi: true,
            _previous: Object.keys(previous).length > 0 ? previous : undefined,
          },
        });

        if (assigneeWillChange && issue.assigneeAgentId && issue.status !== ISSUE_STATUS_BACKLOG) {
          void heartbeat
            .wakeup(issue.assigneeAgentId, {
              source: "assignment",
              triggerDetail: "system",
              reason: "issue_assigned",
              payload: { issueId: issue.id, mutation: "update" },
              requestedByActorType: actor.actorType,
              requestedByActorId: actor.actorId,
              contextSnapshot: { issueId: issue.id, source: "issue.update" },
            })
            .catch((err) => logger.warn({ err, issueId: issue.id }, "wakeup on worker issue update failed"));
        }

        res.status(200).json(buildWorkerApiSuccessResponse(req, { issue }));
      } catch (err) {
        next(err);
      }
    },
  );

  router.post(
    "/agent-hires",
    validate(workerAgentHireSchema),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { companyId } = assertWorkerInstance(req);
        const body = req.body as z.infer<typeof workerAgentHireSchema>;
        await requireAgentInCompany(db, body.agentId, companyId);
        await assertWorkerAgentCanCreateAgents(db, companyId, body.agentId);

        const runId = req.header("x-hive-run-id")?.trim() ?? null;
        const { agent, approval } = await runWorkerApiAgentHire(db, {
          strictSecretsMode,
          companyId,
          runId,
          body,
        });

        res.status(201).json(buildWorkerApiSuccessResponse(req, { agent, approval }));
      } catch (err) {
        next(err);
      }
    },
  );

  router.post(
    "/cost-report",
    validate(workerCostReportSchema),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { companyId } = assertWorkerInstance(req);
        const body = req.body as z.infer<typeof workerCostReportSchema>;
        await requireAgentInCompany(db, body.agentId, companyId);

        const { occurredAt, ...rest } = body;
        const event = await costs.createEvent(companyId, {
          ...rest,
          occurredAt: new Date(occurredAt),
        });

        const actor = getWorkerApiActorInfo(req, body.agentId);
        await logActivity(db, {
          companyId,
          actorType: actor.actorType,
          actorId: actor.actorId,
          agentId: actor.agentId,
          runId: actor.runId,
          action: WORKER_API_ACTIONS.costReport,
          entityType: "cost_event",
          entityId: event.id,
          details: { workerApi: true },
        });

        res.status(201).json(buildWorkerApiSuccessResponse(req, { costEventId: event.id }));
      } catch (err) {
        next(err);
      }
    },
  );

  router.post(
    "/issues/:issueId/comments",
    validate(issueAppendBodySchema),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { companyId } = assertWorkerInstance(req);
        const issueIdParam = req.params.issueId as string;
        const { agentId, body: commentBody } = req.body as z.infer<typeof issueAppendBodySchema>;
        await requireAgentInCompany(db, agentId, companyId);

        const issue = await resolveIssueParam(issues, issueIdParam);
        if (!issue) {
          res.status(404).json({ error: "Issue not found" });
          return;
        }
        if (issue.companyId !== companyId) {
          res.status(403).json({ error: "Forbidden" });
          return;
        }

        if (issue.status === ISSUE_STATUS_IN_PROGRESS && issue.assigneeAgentId === agentId) {
          const runId = req.header("x-hive-run-id")?.trim();
          if (!runId) {
            res.status(401).json({ error: "Agent run id required for checked-out issue" });
            return;
          }
          await issues.assertCheckoutOwner(issue.id, agentId, runId);
        }

        const comment = await issues.addComment(issue.id, commentBody, { agentId });
        const actor = getWorkerApiActorInfo(req, agentId);
        await logActivity(db, {
          companyId,
          actorType: actor.actorType,
          actorId: actor.actorId,
          agentId: actor.agentId,
          runId: actor.runId,
          action: WORKER_API_ACTIONS.issueAppendComment,
          entityType: "issue_comment",
          entityId: comment.id,
          details: { workerApi: true, issueId: issue.id },
        });
        res.status(200).json(buildWorkerApiSuccessResponse(req, { commentId: comment.id, issueId: issue.id }));
      } catch (err) {
        next(err);
      }
    },
  );

  router.post(
    "/issues/:issueId/transition",
    validate(issueTransitionBodySchema),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { companyId } = assertWorkerInstance(req);
        const issueIdParam = req.params.issueId as string;
        const { agentId, status: nextStatus } = req.body as z.infer<typeof issueTransitionBodySchema>;
        await requireAgentInCompany(db, agentId, companyId);

        const issue = await resolveIssueParam(issues, issueIdParam);
        if (!issue) {
          res.status(404).json({ error: "Issue not found" });
          return;
        }
        if (issue.companyId !== companyId) {
          res.status(403).json({ error: "Forbidden" });
          return;
        }
        if (issue.assigneeAgentId !== agentId) {
          res.status(403).json({ error: "Agent is not the issue assignee" });
          return;
        }

        if (issue.status === ISSUE_STATUS_IN_PROGRESS && issue.assigneeAgentId === agentId) {
          const runId = req.header("x-hive-run-id")?.trim();
          if (!runId) {
            res.status(401).json({ error: "Agent run id required for checked-out issue" });
            return;
          }
          await issues.assertCheckoutOwner(issue.id, agentId, runId);
        }

        const updated = await issues.update(issue.id, { status: nextStatus });
        if (!updated) {
          res.status(404).json({ error: "Issue not found" });
          return;
        }
        const actor = getWorkerApiActorInfo(req, agentId);
        await logActivity(db, {
          companyId,
          actorType: actor.actorType,
          actorId: actor.actorId,
          agentId: actor.agentId,
          runId: actor.runId,
          action: WORKER_API_ACTIONS.issueTransitionStatus,
          entityType: "issue",
          entityId: updated.id,
          details: {
            workerApi: true,
            fromStatus: issue.status,
            toStatus: nextStatus,
          },
        });
        res.status(200).json(
          buildWorkerApiSuccessResponse(req, { issueId: updated.id, status: updated.status }),
        );
      } catch (err) {
        next(err);
      }
    },
  );

  router.get("/plugin-tools", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { companyId } = assertWorkerInstance(req);
      const parsedQ = pluginToolsQuerySchema.safeParse(req.query);
      if (!parsedQ.success) {
        res.status(400).json({ error: "Invalid query", details: parsedQ.error.flatten() });
        return;
      }
      const { agentId } = parsedQ.data;
      await requireAgentInCompany(db, agentId, companyId);
      const tools = await listPluginToolCatalogForCompany(db, companyId);
      res.status(200).json(buildWorkerApiSuccessResponse(req, { tools }));
    } catch (err) {
      next(err);
    }
  });

  router.get("/issues/:issueId", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { companyId } = assertWorkerInstance(req);
      const issueIdParam = req.params.issueId as string;
      const parsedQ = issueGetQuerySchema.safeParse(req.query);
      if (!parsedQ.success) {
        res.status(400).json({ error: "Invalid query", details: parsedQ.error.flatten() });
        return;
      }
      const { agentId } = parsedQ.data;
      await requireAgentInCompany(db, agentId, companyId);

      const issue = await resolveIssueParam(issues, issueIdParam);
      if (!issue) {
        res.status(404).json({ error: "Issue not found" });
        return;
      }
      if (issue.companyId !== companyId) {
        res.status(403).json({ error: "Forbidden" });
        return;
      }
      const actor = getWorkerApiActorInfo(req, agentId);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: WORKER_API_ACTIONS.issueGet,
        entityType: "issue",
        entityId: issue.id,
        details: { workerApi: true },
      });
      const result = {
        issueId: issue.id,
        identifier: issue.identifier,
        title: issue.title,
        status: issue.status,
        assigneeAgentId: issue.assigneeAgentId ?? null,
        projectId: issue.projectId ?? null,
      };
      res.status(200).json(buildWorkerApiSuccessResponse(req, result));
    } catch (err) {
      next(err);
    }
  });

  return router;
}
