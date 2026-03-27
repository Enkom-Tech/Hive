import { createHash, randomBytes } from "node:crypto";
import { and, count, desc, eq, gte, isNull, lte, or, sum } from "drizzle-orm";
import type { Db } from "@hive/db";
import {
  agents,
  approvals,
  companies,
  costEvents,
  hiveDeployments,
  inferenceModels,
  modelTrainingRuns,
  heartbeatRuns,
  issues,
} from "@hive/db";
import {
  AGENT_RUNTIME_DEFAULT_MODEL_SLUG_KEY,
  type CreateModelTrainingRun,
  type ModelTrainingCallbackBody,
  type PromoteModelTrainingRun,
} from "@hive/shared";
import { conflict, forbidden, notFound, unprocessable } from "../errors.js";

export function hashTrainingCallbackToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function callbackBodyDigest(body: ModelTrainingCallbackBody): string {
  const stable = JSON.stringify({
    status: body.status,
    resultBaseUrl: body.resultBaseUrl ?? null,
    resultMetadata: body.resultMetadata ?? {},
    error: body.error ?? null,
    externalJobRef: body.externalJobRef ?? null,
  });
  return createHash("sha256").update(stable, "utf8").digest("hex");
}

export function modelTrainingService(
  db: Db,
  opts: {
    internalOperatorSecret?: string;
    /** e.g. https://board.example.com — used for dispatch payload URLs */
    apiPublicBaseUrl?: string;
  },
) {
  function resolveApiBase(): string {
    const b = opts.apiPublicBaseUrl?.trim().replace(/\/$/, "");
    if (b) return b;
    return "";
  }

  async function resolveRunnerUrl(companyId: string, deploymentId: string, override: string | null | undefined) {
    if (override?.trim()) return override.trim();
    const [co] = await db
      .select({ url: companies.modelTrainingRunnerUrl })
      .from(companies)
      .where(eq(companies.id, companyId))
      .limit(1);
    if (co?.url?.trim()) return co.url.trim();
    const [dep] = await db
      .select({ url: hiveDeployments.modelTrainingRunnerUrl })
      .from(hiveDeployments)
      .where(eq(hiveDeployments.id, deploymentId))
      .limit(1);
    return dep?.url?.trim() ?? "";
  }

  async function loadRunForCompany(companyId: string, runId: string) {
    const [row] = await db
      .select()
      .from(modelTrainingRuns)
      .where(and(eq(modelTrainingRuns.id, runId), eq(modelTrainingRuns.companyId, companyId)))
      .limit(1);
    return row ?? null;
  }

  async function loadRunById(runId: string) {
    const [row] = await db.select().from(modelTrainingRuns).where(eq(modelTrainingRuns.id, runId)).limit(1);
    return row ?? null;
  }

  function verifyCallbackAuth(authHeader: string | undefined, run: typeof modelTrainingRuns.$inferSelect): boolean {
    const h = authHeader;
    const tok =
      typeof h === "string" && h.toLowerCase().startsWith("bearer ") ? h.slice(7).trim() : "";
    if (!tok) return false;
    const op = opts.internalOperatorSecret?.trim();
    if (op && tok === op) return true;
    return hashTrainingCallbackToken(tok) === run.callbackTokenHash;
  }

  return {
    async createRun(
      companyId: string,
      input: CreateModelTrainingRun,
      _actor: { dispatch: boolean },
    ): Promise<{
      run: typeof modelTrainingRuns.$inferSelect;
      callbackToken: string;
      dispatchSkippedReason: string | null;
      dispatchError: string | null;
    }> {
      const [company] = await db
        .select()
        .from(companies)
        .where(eq(companies.id, companyId))
        .limit(1);
      if (!company) throw notFound("Company not found");

      if (input.agentId) {
        const [ag] = await db
          .select({ id: agents.id })
          .from(agents)
          .where(and(eq(agents.id, input.agentId), eq(agents.companyId, companyId)))
          .limit(1);
        if (!ag) throw unprocessable("Agent does not belong to this company");
      }

      if (input.sourceInferenceModelId) {
        const [im] = await db
          .select({ id: inferenceModels.id })
          .from(inferenceModels)
          .where(
            and(
              eq(inferenceModels.id, input.sourceInferenceModelId),
              eq(inferenceModels.deploymentId, company.deploymentId),
              or(isNull(inferenceModels.companyId), eq(inferenceModels.companyId, companyId)),
            ),
          )
          .limit(1);
        if (!im) throw unprocessable("Source inference model not found for this company");
      }

      const idempotencyKey = input.idempotencyKey?.trim() || null;
      if (idempotencyKey) {
        const [dup] = await db
          .select()
          .from(modelTrainingRuns)
          .where(
            and(eq(modelTrainingRuns.companyId, companyId), eq(modelTrainingRuns.idempotencyKey, idempotencyKey)),
          )
          .limit(1);
        if (dup) {
          return {
            run: dup,
            callbackToken: "",
            dispatchSkippedReason: "idempotent_hit",
            dispatchError: null,
          };
        }
      }

      const callbackToken = randomBytes(32).toString("hex");
      const callbackTokenHash = hashTrainingCallbackToken(callbackToken);

      const [run] = await db
        .insert(modelTrainingRuns)
        .values({
          companyId,
          deploymentId: company.deploymentId,
          agentId: input.agentId ?? null,
          sourceInferenceModelId: input.sourceInferenceModelId ?? null,
          proposedModelSlug: input.proposedModelSlug.trim(),
          status: "queued",
          runnerKind: input.runnerKind ?? "http_json",
          runnerTargetUrl: input.runnerTargetUrl?.trim() || null,
          callbackTokenHash,
          datasetFilterSpec: input.datasetFilterSpec ?? null,
          idempotencyKey,
          updatedAt: new Date(),
        })
        .returning();

      if (!run) throw new Error("insert model_training_runs failed");

      let dispatchSkippedReason: string | null = null;
      let dispatchError: string | null = null;

      if (input.dispatch !== false) {
        const target = await resolveRunnerUrl(companyId, company.deploymentId, run.runnerTargetUrl);
        if (!target) {
          dispatchSkippedReason = "no_runner_url";
        } else {
          const apiBase = resolveApiBase();
          if (!apiBase) {
            dispatchSkippedReason = "no_api_public_base_url";
          } else {
            const payload = {
              hiveTrainingRunId: run.id,
              companyId,
              proposedModelSlug: run.proposedModelSlug,
              runnerKind: run.runnerKind,
              datasetExportUrl: `${apiBase}/api/companies/${companyId}/model-training-runs/${run.id}/dataset-export`,
              callbackUrl: `${apiBase}/api/internal/hive/model-training-callback`,
              callbackToken,
            };
            try {
              const ac = new AbortController();
              const t = setTimeout(() => ac.abort(), 15_000);
              const res = await fetch(target, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(payload),
                signal: ac.signal,
              });
              clearTimeout(t);
              if (!res.ok) {
                const excerpt = (await res.text()).slice(0, 2000);
                dispatchError = `runner HTTP ${res.status}: ${excerpt}`;
                await db
                  .update(modelTrainingRuns)
                  .set({
                    status: "failed",
                    error: dispatchError,
                    updatedAt: new Date(),
                  })
                  .where(eq(modelTrainingRuns.id, run.id));
                return {
                  run: { ...run, status: "failed", error: dispatchError },
                  callbackToken,
                  dispatchSkippedReason: null,
                  dispatchError,
                };
              }
              await db
                .update(modelTrainingRuns)
                .set({ status: "dispatched", updatedAt: new Date() })
                .where(eq(modelTrainingRuns.id, run.id));
              return {
                run: { ...run, status: "dispatched" },
                callbackToken,
                dispatchSkippedReason: null,
                dispatchError: null,
              };
            } catch (e) {
              dispatchError = e instanceof Error ? e.message : String(e);
              await db
                .update(modelTrainingRuns)
                .set({
                  status: "failed",
                  error: dispatchError,
                  updatedAt: new Date(),
                })
                .where(eq(modelTrainingRuns.id, run.id));
              return {
                run: { ...run, status: "failed", error: dispatchError },
                callbackToken,
                dispatchSkippedReason: null,
                dispatchError,
              };
            }
          }
        }
      }

      return { run, callbackToken, dispatchSkippedReason, dispatchError: null };
    },

    async listRuns(companyId: string, query: { status?: string; agentId?: string; limit: number }) {
      const conds = [eq(modelTrainingRuns.companyId, companyId)] as ReturnType<typeof eq>[];
      if (query.status) conds.push(eq(modelTrainingRuns.status, query.status));
      if (query.agentId) conds.push(eq(modelTrainingRuns.agentId, query.agentId));
      return db
        .select()
        .from(modelTrainingRuns)
        .where(and(...conds))
        .orderBy(desc(modelTrainingRuns.createdAt))
        .limit(query.limit);
    },

    async getRun(companyId: string, runId: string) {
      return loadRunForCompany(companyId, runId);
    },

    async getRunAny(runId: string) {
      return loadRunById(runId);
    },

    async cancelRun(companyId: string, runId: string) {
      const row = await loadRunForCompany(companyId, runId);
      if (!row) throw notFound("Training run not found");
      if (row.status === "promoted" || row.status === "cancelled") {
        throw conflict(`Run cannot be cancelled from status ${row.status}`);
      }
      const [updated] = await db
        .update(modelTrainingRuns)
        .set({ status: "cancelled", updatedAt: new Date() })
        .where(eq(modelTrainingRuns.id, runId))
        .returning();
      return updated!;
    },

    verifyCallbackAuth,

    async applyCallback(
      body: ModelTrainingCallbackBody,
      authHeader: string | undefined,
    ): Promise<typeof modelTrainingRuns.$inferSelect> {
      const run = await loadRunById(body.runId);
      if (!run) throw notFound("Training run not found");
      if (!verifyCallbackAuth(authHeader, run)) {
        throw forbidden("Invalid training callback authorization");
      }
      if (run.status === "promoted" || run.status === "cancelled") {
        return run;
      }

      const digest = callbackBodyDigest(body);
      if (run.lastCallbackDigest === digest) {
        return run;
      }

      if (body.status === "running") {
        const [updated] = await db
          .update(modelTrainingRuns)
          .set({
            status: "running",
            externalJobRef: body.externalJobRef?.trim() || run.externalJobRef,
            resultMetadata: { ...run.resultMetadata, ...(body.resultMetadata ?? {}) },
            lastCallbackDigest: digest,
            error: null,
            updatedAt: new Date(),
          })
          .where(eq(modelTrainingRuns.id, run.id))
          .returning();
        return updated!;
      }

      if (body.status === "failed") {
        const [updated] = await db
          .update(modelTrainingRuns)
          .set({
            status: "failed",
            error: body.error?.trim() || "Training failed",
            externalJobRef: body.externalJobRef?.trim() || run.externalJobRef,
            resultMetadata: { ...run.resultMetadata, ...(body.resultMetadata ?? {}) },
            lastCallbackDigest: digest,
            updatedAt: new Date(),
          })
          .where(eq(modelTrainingRuns.id, run.id))
          .returning();
        return updated!;
      }

      // succeeded
      const baseUrl = body.resultBaseUrl?.trim();
      if (!baseUrl) {
        throw unprocessable("resultBaseUrl is required when status is succeeded");
      }
      const [updated] = await db
        .update(modelTrainingRuns)
        .set({
          status: "succeeded",
          resultBaseUrl: baseUrl,
          externalJobRef: body.externalJobRef?.trim() || run.externalJobRef,
          resultMetadata: { ...run.resultMetadata, ...(body.resultMetadata ?? {}) },
          lastCallbackDigest: digest,
          error: null,
          updatedAt: new Date(),
        })
        .where(eq(modelTrainingRuns.id, run.id))
        .returning();
      return updated!;
    },

    async promoteRun(
      companyId: string,
      runId: string,
      input: PromoteModelTrainingRun,
    ): Promise<{
      run: typeof modelTrainingRuns.$inferSelect;
      inferenceModel: typeof inferenceModels.$inferSelect;
    }> {
      const run = await loadRunForCompany(companyId, runId);
      if (!run) throw notFound("Training run not found");
      if (run.status !== "succeeded") {
        throw conflict(`Can only promote a succeeded run (status=${run.status})`);
      }
      const baseUrl = run.resultBaseUrl?.trim();
      if (!baseUrl) throw conflict("Run has no resultBaseUrl");

      const [company] = await db
        .select()
        .from(companies)
        .where(eq(companies.id, companyId))
        .limit(1);
      if (!company) throw notFound("Company not found");

      if (company.requireApprovalForModelPromotion) {
        const approvalId = input.approvalId?.trim();
        if (!approvalId) {
          throw unprocessable("approvalId is required when company requires approval for model promotion");
        }
        const [ap] = await db
          .select()
          .from(approvals)
          .where(
            and(
              eq(approvals.id, approvalId),
              eq(approvals.companyId, companyId),
              eq(approvals.type, "promote_model"),
              eq(approvals.status, "approved"),
            ),
          )
          .limit(1);
        if (!ap) {
          throw unprocessable("Approved promote_model approval not found");
        }
        const p = ap.payload as Record<string, unknown>;
        if (String(p.modelTrainingRunId ?? "") !== runId) {
          throw unprocessable("Approval does not match this training run");
        }
      }

      const slug = run.proposedModelSlug.trim();
      const [existing] = await db
        .select()
        .from(inferenceModels)
        .where(
          and(
            eq(inferenceModels.deploymentId, company.deploymentId),
            eq(inferenceModels.modelSlug, slug),
            eq(inferenceModels.companyId, companyId),
          ),
        )
        .limit(1);

      let im: typeof inferenceModels.$inferSelect;
      if (existing) {
        const [u] = await db
          .update(inferenceModels)
          .set({ baseUrl, enabled: true, updatedAt: new Date() })
          .where(eq(inferenceModels.id, existing.id))
          .returning();
        im = u!;
      } else {
        const [ins] = await db
          .insert(inferenceModels)
          .values({
            deploymentId: company.deploymentId,
            companyId,
            modelSlug: slug,
            kind: "chat",
            baseUrl,
            enabled: true,
            updatedAt: new Date(),
          })
          .returning();
        im = ins!;
      }

      const [updatedRun] = await db
        .update(modelTrainingRuns)
        .set({
          status: "promoted",
          promotedInferenceModelId: im.id,
          promotedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(modelTrainingRuns.id, run.id))
        .returning();

      if (input.alsoSetAgentDefaultModel !== false && run.agentId) {
        const [ag] = await db.select().from(agents).where(eq(agents.id, run.agentId)).limit(1);
        if (ag && ag.companyId === companyId) {
          const rc = { ...((ag.runtimeConfig as Record<string, unknown> | null) ?? {}) };
          rc[AGENT_RUNTIME_DEFAULT_MODEL_SLUG_KEY] = slug;
          await db
            .update(agents)
            .set({ runtimeConfig: rc, updatedAt: new Date() })
            .where(eq(agents.id, ag.id));
        }
      }

      return { run: updatedRun!, inferenceModel: im };
    },

    async *streamDatasetExport(
      companyId: string,
      runId: string,
      authHeader: string | undefined,
      trustBoardAlreadyVerified?: boolean,
    ): AsyncGenerator<string, void, void> {
      const run = await loadRunForCompany(companyId, runId);
      if (!run) throw notFound("Training run not found");
      if (!trustBoardAlreadyVerified && !verifyCallbackAuth(authHeader, run)) {
        throw forbidden("Invalid authorization for dataset export");
      }

      const agentId = run.agentId;
      const filter = (run.datasetFilterSpec ?? {}) as Record<string, unknown>;
      const limitRuns = typeof filter.maxRuns === "number" && filter.maxRuns > 0 ? Math.min(filter.maxRuns, 500) : 100;

      const runRows = await db
        .select()
        .from(heartbeatRuns)
        .where(
          agentId
            ? and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.agentId, agentId))
            : eq(heartbeatRuns.companyId, companyId),
        )
        .orderBy(desc(heartbeatRuns.startedAt))
        .limit(limitRuns);

      for (const hr of runRows) {
        const ctx = (hr.contextSnapshot ?? {}) as Record<string, unknown>;
        const issueId = typeof ctx.issueId === "string" ? ctx.issueId : null;
        let issueTitle: string | null = null;
        let issueStatus: string | null = null;
        if (issueId) {
          const [is] = await db
            .select({ title: issues.title, status: issues.status })
            .from(issues)
            .where(and(eq(issues.id, issueId), eq(issues.companyId, companyId)))
            .limit(1);
          issueTitle = is?.title ?? null;
          issueStatus = is?.status ?? null;
        }

        const line = {
          type: "heartbeat_run",
          runId: hr.id,
          agentId: hr.agentId,
          status: hr.status,
          startedAt: hr.startedAt?.toISOString() ?? null,
          finishedAt: hr.finishedAt?.toISOString() ?? null,
          issueId,
          issueTitle,
          issueStatus,
          usageSummary: hr.usageJson ?? null,
          resultSummary: hr.resultJson ?? null,
          contextExcerpt: {
            issueId: ctx.issueId ?? null,
            projectId: ctx.projectId ?? null,
          },
        };
        yield `${JSON.stringify(line)}\n`;
      }

      const ninetyDaysMs = 90 * 24 * 60 * 60 * 1000;
      const untilDefault = new Date();
      const sinceDefault = new Date(untilDefault.getTime() - ninetyDaysMs);
      const parseIso = (v: unknown): Date | null => {
        if (typeof v !== "string" || !v.trim()) return null;
        const d = new Date(v.trim());
        return Number.isNaN(d.getTime()) ? null : d;
      };
      let since = parseIso(filter.costOccurredAfter) ?? sinceDefault;
      let until = parseIso(filter.costOccurredBefore) ?? untilDefault;
      if (since > until) {
        const t = since;
        since = until;
        until = t;
      }

      const costConditions = [
        eq(costEvents.companyId, companyId),
        gte(costEvents.occurredAt, since),
        lte(costEvents.occurredAt, until),
      ];
      if (agentId) {
        costConditions.push(eq(costEvents.agentId, agentId));
      }
      const costWhereAnd = and(...costConditions);

      const [totalsRow] = await db
        .select({
          totalCostCents: sum(costEvents.costCents),
          totalInputTokens: sum(costEvents.inputTokens),
          totalOutputTokens: sum(costEvents.outputTokens),
          eventCount: count(),
        })
        .from(costEvents)
        .where(costWhereAnd);

      const byModelRows = await db
        .select({
          model: costEvents.model,
          provider: costEvents.provider,
          costCents: sum(costEvents.costCents),
          inputTokens: sum(costEvents.inputTokens),
          outputTokens: sum(costEvents.outputTokens),
          evs: count(),
        })
        .from(costEvents)
        .where(costWhereAnd)
        .groupBy(costEvents.model, costEvents.provider);

      const toInt = (v: unknown): number => (typeof v === "string" ? parseInt(v, 10) : Number(v)) || 0;
      const byModel = byModelRows.slice(0, 50).map((r) => ({
        model: r.model,
        provider: r.provider,
        costCents: toInt(r.costCents),
        inputTokens: toInt(r.inputTokens),
        outputTokens: toInt(r.outputTokens),
        eventCount: toInt(r.evs),
      }));

      const aggregateLine = {
        type: "cost_aggregate",
        companyId,
        agentId: agentId ?? null,
        window: { since: since.toISOString(), until: until.toISOString() },
        totalCostCents: toInt(totalsRow?.totalCostCents),
        totalInputTokens: toInt(totalsRow?.totalInputTokens),
        totalOutputTokens: toInt(totalsRow?.totalOutputTokens),
        eventCount: toInt(totalsRow?.eventCount),
        byModel,
      };
      yield `${JSON.stringify(aggregateLine)}\n`;
    },
  };
}
