import type { FastifyInstance } from "fastify";
import type { Db } from "@hive/db";
import { modelTrainingRuns } from "@hive/db";
import {
  createModelTrainingRunSchema,
  listModelTrainingRunsQuerySchema,
  promoteModelTrainingRunSchema,
} from "@hive/shared";
import { modelTrainingService } from "../services/model-training.js";
import { assertBoard, assertCompanyPermission, assertCompanyRead, getActorInfo } from "./authz.js";
import { logActivity } from "../services/index.js";

function sanitizeRunRow(row: typeof modelTrainingRuns.$inferSelect) {
  const { callbackTokenHash: _omit, ...rest } = row;
  return rest;
}

export function registerModelTrainingRoutesF(
  fastify: FastifyInstance,
  db: Db,
  opts: { internalOperatorSecret?: string; apiPublicBaseUrl?: string },
): void {
  const training = modelTrainingService(db, {
    internalOperatorSecret: opts.internalOperatorSecret,
    apiPublicBaseUrl: opts.apiPublicBaseUrl,
  });

  fastify.get<{ Params: { companyId: string } }>("/api/companies/:companyId/model-training-runs", async (req, reply) => {
    const { companyId } = req.params;
    await assertCompanyRead(db, req, companyId);
    await assertCompanyPermission(db, req, companyId, "models:train");
    const parsed = listModelTrainingRunsQuerySchema.safeParse(req.query);
    if (!parsed.success) return reply.status(400).send({ error: "Invalid query", details: parsed.error.issues });
    const rows = await training.listRuns(companyId, parsed.data);
    return reply.send(rows.map(sanitizeRunRow));
  });

  fastify.get<{ Params: { companyId: string; runId: string } }>("/api/companies/:companyId/model-training-runs/:runId", async (req, reply) => {
    const { companyId, runId } = req.params;
    await assertCompanyRead(db, req, companyId);
    await assertCompanyPermission(db, req, companyId, "models:train");
    const row = await training.getRun(companyId, runId);
    if (!row) return reply.status(404).send({ error: "Training run not found" });
    return reply.send(sanitizeRunRow(row));
  });

  fastify.post<{ Params: { companyId: string } }>("/api/companies/:companyId/model-training-runs", async (req, reply) => {
    assertBoard(req);
    const { companyId } = req.params;
    await assertCompanyPermission(db, req, companyId, "models:train");
    const parsed = createModelTrainingRunSchema.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: "Validation error", details: parsed.error.issues });
    const body = parsed.data as import("@hive/shared").CreateModelTrainingRun;
    const result = await training.createRun(companyId, body, { dispatch: body.dispatch !== false });
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType, actorId: actor.actorId,
      agentId: actor.agentId, runId: actor.runId,
      action: "model_training_run.created",
      entityType: "model_training_run", entityId: result.run.id,
      details: {
        proposedModelSlug: result.run.proposedModelSlug,
        dispatchSkippedReason: result.dispatchSkippedReason,
        dispatchError: result.dispatchError,
        idempotentHit: result.dispatchSkippedReason === "idempotent_hit",
      },
    });
    return reply.status(201).send({
      run: sanitizeRunRow(result.run),
      callbackToken: result.callbackToken || null,
      dispatchSkippedReason: result.dispatchSkippedReason,
      dispatchError: result.dispatchError,
    });
  });

  fastify.post<{ Params: { companyId: string; runId: string } }>("/api/companies/:companyId/model-training-runs/:runId/cancel", async (req, reply) => {
    assertBoard(req);
    const { companyId, runId } = req.params;
    await assertCompanyPermission(db, req, companyId, "models:train");
    const row = await training.cancelRun(companyId, runId);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType, actorId: actor.actorId,
      agentId: actor.agentId, runId: actor.runId,
      action: "model_training_run.cancelled",
      entityType: "model_training_run", entityId: runId,
      details: {},
    });
    return reply.send(sanitizeRunRow(row));
  });

  fastify.post<{ Params: { companyId: string; runId: string } }>("/api/companies/:companyId/model-training-runs/:runId/promote", async (req, reply) => {
    assertBoard(req);
    const { companyId, runId } = req.params;
    await assertCompanyPermission(db, req, companyId, "models:train");
    const parsed = promoteModelTrainingRunSchema.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: "Validation error", details: parsed.error.issues });
    const out = await training.promoteRun(companyId, runId, parsed.data as import("@hive/shared").PromoteModelTrainingRun);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType, actorId: actor.actorId,
      agentId: actor.agentId, runId: actor.runId,
      action: "model_training_run.promoted",
      entityType: "model_training_run", entityId: runId,
      details: { inferenceModelId: out.inferenceModel.id, modelSlug: out.inferenceModel.modelSlug },
    });
    return reply.send({ run: sanitizeRunRow(out.run), inferenceModel: out.inferenceModel });
  });

  fastify.get<{ Params: { companyId: string; runId: string } }>("/api/companies/:companyId/model-training-runs/:runId/dataset-export", async (req, reply) => {
    const { companyId, runId } = req.params;
    const run = await training.getRun(companyId, runId);
    if (!run) return reply.status(404).send({ error: "Training run not found" });
    const auth = req.headers.authorization;
    const bearerOk = training.verifyCallbackAuth(auth, run);
    const trustBoard = !bearerOk;
    if (trustBoard) {
      await assertCompanyRead(db, req, companyId);
      await assertCompanyPermission(db, req, companyId, "models:train");
    }
    reply.raw.setHeader("content-type", "application/x-ndjson; charset=utf-8");
    reply.hijack();
    for await (const chunk of training.streamDatasetExport(companyId, runId, auth, trustBoard)) {
      reply.raw.write(chunk);
    }
    reply.raw.end();
  });
}
