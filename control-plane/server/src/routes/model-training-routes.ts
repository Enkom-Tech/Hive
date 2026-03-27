import { Router } from "express";
import type { Db } from "@hive/db";
import { modelTrainingRuns } from "@hive/db";
import {
  createModelTrainingRunSchema,
  listModelTrainingRunsQuerySchema,
  promoteModelTrainingRunSchema,
} from "@hive/shared";
import { validate } from "../middleware/validate.js";
import { modelTrainingService } from "../services/model-training.js";
import { assertBoard, assertCompanyPermission, assertCompanyRead, getActorInfo } from "./authz.js";
import { logActivity } from "../services/index.js";

export function registerModelTrainingRoutes(
  router: Router,
  db: Db,
  opts: { internalOperatorSecret?: string; apiPublicBaseUrl?: string },
): void {
  const training = modelTrainingService(db, {
    internalOperatorSecret: opts.internalOperatorSecret,
    apiPublicBaseUrl: opts.apiPublicBaseUrl,
  });

  router.get("/:companyId/model-training-runs", async (req, res, next) => {
    try {
      const companyId = req.params.companyId as string;
      await assertCompanyRead(db, req, companyId);
      await assertCompanyPermission(db, req, companyId, "models:train");
      const parsed = listModelTrainingRunsQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid query", details: parsed.error.issues });
        return;
      }
      const rows = await training.listRuns(companyId, parsed.data);
      res.json(rows.map(sanitizeRunRow));
    } catch (e) {
      next(e);
    }
  });

  router.get("/:companyId/model-training-runs/:runId", async (req, res, next) => {
    try {
      const companyId = req.params.companyId as string;
      const runId = req.params.runId as string;
      await assertCompanyRead(db, req, companyId);
      await assertCompanyPermission(db, req, companyId, "models:train");
      const row = await training.getRun(companyId, runId);
      if (!row) {
        res.status(404).json({ error: "Training run not found" });
        return;
      }
      res.json(sanitizeRunRow(row));
    } catch (e) {
      next(e);
    }
  });

  router.post("/:companyId/model-training-runs", validate(createModelTrainingRunSchema), async (req, res, next) => {
    try {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      await assertCompanyPermission(db, req, companyId, "models:train");
      const body = req.body as import("@hive/shared").CreateModelTrainingRun;
      const result = await training.createRun(companyId, body, { dispatch: body.dispatch !== false });
      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "model_training_run.created",
        entityType: "model_training_run",
        entityId: result.run.id,
        details: {
          proposedModelSlug: result.run.proposedModelSlug,
          dispatchSkippedReason: result.dispatchSkippedReason,
          dispatchError: result.dispatchError,
          idempotentHit: result.dispatchSkippedReason === "idempotent_hit",
        },
      });
      res.status(201).json({
        run: sanitizeRunRow(result.run),
        callbackToken: result.callbackToken || null,
        dispatchSkippedReason: result.dispatchSkippedReason,
        dispatchError: result.dispatchError,
      });
    } catch (e) {
      next(e);
    }
  });

  router.post("/:companyId/model-training-runs/:runId/cancel", async (req, res, next) => {
    try {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      const runId = req.params.runId as string;
      await assertCompanyPermission(db, req, companyId, "models:train");
      const row = await training.cancelRun(companyId, runId);
      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "model_training_run.cancelled",
        entityType: "model_training_run",
        entityId: runId,
        details: {},
      });
      res.json(sanitizeRunRow(row));
    } catch (e) {
      next(e);
    }
  });

  router.post(
    "/:companyId/model-training-runs/:runId/promote",
    validate(promoteModelTrainingRunSchema),
    async (req, res, next) => {
      try {
        assertBoard(req);
        const companyId = req.params.companyId as string;
        const runId = req.params.runId as string;
        await assertCompanyPermission(db, req, companyId, "models:train");
        const body = req.body as import("@hive/shared").PromoteModelTrainingRun;
        const out = await training.promoteRun(companyId, runId, body);
        const actor = getActorInfo(req);
        await logActivity(db, {
          companyId,
          actorType: actor.actorType,
          actorId: actor.actorId,
          agentId: actor.agentId,
          runId: actor.runId,
          action: "model_training_run.promoted",
          entityType: "model_training_run",
          entityId: runId,
          details: { inferenceModelId: out.inferenceModel.id, modelSlug: out.inferenceModel.modelSlug },
        });
        res.json({ run: sanitizeRunRow(out.run), inferenceModel: out.inferenceModel });
      } catch (e) {
        next(e);
      }
    },
  );

  router.get("/:companyId/model-training-runs/:runId/dataset-export", async (req, res, next) => {
    try {
      const companyId = req.params.companyId as string;
      const runId = req.params.runId as string;
      const run = await training.getRun(companyId, runId);
      if (!run) {
        res.status(404).json({ error: "Training run not found" });
        return;
      }
      const auth = req.headers.authorization;
      const bearerOk = training.verifyCallbackAuth(auth, run);
      const trustBoard = !bearerOk;
      if (trustBoard) {
        await assertCompanyRead(db, req, companyId);
        await assertCompanyPermission(db, req, companyId, "models:train");
      }
      res.setHeader("content-type", "application/x-ndjson; charset=utf-8");
      for await (const chunk of training.streamDatasetExport(companyId, runId, auth, trustBoard)) {
        res.write(chunk);
      }
      res.end();
    } catch (e) {
      next(e);
    }
  });
}

function sanitizeRunRow(row: typeof modelTrainingRuns.$inferSelect) {
  const { callbackTokenHash: _omit, ...rest } = row;
  return rest;
}
