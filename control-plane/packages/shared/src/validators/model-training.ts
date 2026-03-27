import { z } from "zod";
import { MODEL_TRAINING_RUNNER_KINDS, MODEL_TRAINING_RUN_STATUSES } from "../constants.js";

export const trainingResultEvalSchema = z
  .object({
    metrics: z.record(z.string(), z.number()).optional(),
    judgeModel: z.string().max(512).optional(),
    notes: z.string().max(16_000).optional(),
  })
  .optional();

export const createModelTrainingRunSchema = z.object({
  agentId: z.string().uuid().optional().nullable(),
  sourceInferenceModelId: z.string().uuid().optional().nullable(),
  proposedModelSlug: z.string().min(1).max(512),
  runnerKind: z.enum(MODEL_TRAINING_RUNNER_KINDS).optional().default("http_json"),
  runnerTargetUrl: z.string().url().max(2048).optional().nullable(),
  datasetFilterSpec: z.record(z.string(), z.unknown()).optional().nullable(),
  idempotencyKey: z.string().min(1).max(256).optional().nullable(),
  dispatch: z.boolean().optional().default(true),
});

export type CreateModelTrainingRun = z.infer<typeof createModelTrainingRunSchema>;

export const promoteModelTrainingRunSchema = z.object({
  approvalId: z.string().uuid().optional().nullable(),
  alsoSetAgentDefaultModel: z.boolean().optional().default(true),
});

export type PromoteModelTrainingRun = z.infer<typeof promoteModelTrainingRunSchema>;

export const modelTrainingCallbackBodySchema = z.object({
  runId: z.string().uuid(),
  status: z.enum(["running", "succeeded", "failed"]),
  externalJobRef: z.string().max(1024).optional().nullable(),
  resultBaseUrl: z.string().url().max(2048).optional().nullable(),
  resultMetadata: z.record(z.string(), z.unknown()).optional().default({}),
  error: z.string().max(16_000).optional().nullable(),
});

export type ModelTrainingCallbackBody = z.infer<typeof modelTrainingCallbackBodySchema>;

export const listModelTrainingRunsQuerySchema = z.object({
  status: z.enum(MODEL_TRAINING_RUN_STATUSES).optional(),
  agentId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional().default(50),
});
