import type { FastifyInstance } from "fastify";
import { and, eq, sql } from "drizzle-orm";
import { workerApiIdempotency } from "@hive/db";
import {
  ISSUE_STATUS_BACKLOG,
  ISSUE_STATUS_CANCELLED,
  ISSUE_STATUS_DONE,
  ISSUE_STATUS_IN_PROGRESS,
  ISSUE_STATUSES_CLOSED,
} from "@hive/shared";
import { z } from "zod";
import {
  createOrFoldIntent,
  deliverWorkAvailable,
  insertIntentLink,
  logActivity,
  publishLiveEvent,
  WORKABLE_STATUSES_FOR_WEBHOOK,
} from "../../services/index.js";
import { assertWorkerInstance, getWorkerApiActorInfo } from "../authz.js";
import { HttpError } from "../../errors.js";
import { logger } from "../../middleware/logger.js";
import {
  assertWorkerAgentCanAssignTasks,
  assertWorkerIssueDepartmentConstraints,
} from "../worker-api-issue-helpers.js";
import {
  parseWorkerApiIdempotencyKey,
  WORKER_API_IDEMPOTENCY_ROUTES,
  workerApiIdempotencyAdvisoryKeys,
} from "../worker-api-idempotency.js";
import {
  adaptReplayedWorkerApiBody,
  buildWorkerApiSuccessResponse,
  workerApiSuccessJsonBody,
} from "../worker-api-payload.js";
import { requireAgentInCompany, resolveIssueParam } from "./helpers.js";
import {
  WORKER_API_ACTIONS,
  workerCreateIssueSchema,
  workerIssuePatchSchema,
} from "./schemas.js";
import type { WorkerApiRoutesContext } from "./worker-api-routes-context.js";

export function registerWorkerApiIssueWriteRoutesFastify(
  fastify: FastifyInstance,
  ctx: WorkerApiRoutesContext,
) {
  const { db, issues, heartbeat } = ctx;

  fastify.post<{ Body: z.infer<typeof workerCreateIssueSchema> }>(
    "/issues",
    async (req, reply) => {
      const body = workerCreateIssueSchema.parse(req.body);
      const { companyId } = assertWorkerInstance(req);
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
        return reply.status(201).send(buildWorkerApiSuccessResponse(req, { issue }));
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
        const responseBody = JSON.parse(
          JSON.stringify(workerApiSuccessJsonBody({ issue: created })),
        ) as Record<string, unknown>;
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
        return reply.status(txResult.httpStatus).send(adaptReplayedWorkerApiBody(req, txResult.body));
      }

      await emitWorkerIssueCreateSideEffects(txResult.issue, txResult.intentResult);
      return reply
        .status(201)
        .send(buildWorkerApiSuccessResponse(req, (txResult.body as { result: unknown }).result));
    },
  );

  fastify.patch<{ Params: { issueId: string }; Body: z.infer<typeof workerIssuePatchSchema> }>(
    "/issues/:issueId",
    async (req, reply) => {
      const body = workerIssuePatchSchema.parse(req.body);
      const { companyId } = assertWorkerInstance(req);
      const issueIdParam = req.params.issueId;
      const { agentId, ...patchRest } = body;
      await requireAgentInCompany(db, agentId, companyId);

      const existing = await resolveIssueParam(issues, issueIdParam);
      if (!existing) return reply.status(404).send({ error: "Issue not found" });
      if (existing.companyId !== companyId) return reply.status(403).send({ error: "Forbidden" });

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
        departmentId: patchRest.departmentId === undefined ? existing.departmentId : patchRest.departmentId,
        assigneeAgentId: patchRest.assigneeAgentId === undefined ? existing.assigneeAgentId : patchRest.assigneeAgentId,
        assigneeUserId: patchRest.assigneeUserId === undefined ? existing.assigneeUserId : patchRest.assigneeUserId,
      });

      if (existing.status === ISSUE_STATUS_IN_PROGRESS && existing.assigneeAgentId === agentId) {
        const runIdRaw = req.headers["x-hive-run-id"];
        const runId = (Array.isArray(runIdRaw) ? runIdRaw[0] : runIdRaw)?.trim();
        if (!runId) {
          return reply.status(401).send({ error: "Agent run id required for checked-out issue" });
        }
        await issues.assertCheckoutOwner(existing.id, agentId, runId);
      }

      let issue;
      try {
        issue = await issues.update(existing.id, patchRest);
      } catch (err) {
        if (err instanceof HttpError && err.status === 422) {
          logger.warn({ issueId: existing.id, companyId, err: (err as Error).message }, "worker issue update rejected");
        }
        throw err;
      }
      if (!issue) return reply.status(404).send({ error: "Issue not found" });

      const movedToClosed =
        (ISSUE_STATUSES_CLOSED as readonly string[]).includes(issue.status) &&
        !(ISSUE_STATUSES_CLOSED as readonly string[]).includes(existing.status);
      if (movedToClosed && existing.executionRunId) {
        const closedTerminal: "done" | "cancelled" | null =
          issue.status === ISSUE_STATUS_DONE
            ? "done"
            : issue.status === ISSUE_STATUS_CANCELLED
              ? "cancelled"
              : null;
        if (closedTerminal) {
          void heartbeat
            .finishRunForIssueClosure(existing.executionRunId, closedTerminal)
            .catch((err) => logger.warn({ err, runId: existing.executionRunId }, "finish run for issue closure failed"));
        }
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

      return reply.status(200).send(buildWorkerApiSuccessResponse(req, { issue }));
    },
  );
}
