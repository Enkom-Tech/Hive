import { eq, sql } from "drizzle-orm";
import type { Db } from "@hive/db";
import { agentRuntimeState, agents, heartbeatRuns } from "@hive/db";
import type { AdapterExecutionResult } from "../../adapters/index.js";
import { costService } from "../costs.js";

export interface CostApplicationDeps {
  db: Db;
}

export function createCostApplication(deps: CostApplicationDeps) {
  const { db } = deps;
  const costs = costService(db);

  async function ensureRuntimeState(agent: typeof agents.$inferSelect) {
    const existing = await db
      .select()
      .from(agentRuntimeState)
      .where(eq(agentRuntimeState.agentId, agent.id))
      .then((rows) => rows[0] ?? null);
    if (existing) return existing;

    return db
      .insert(agentRuntimeState)
      .values({
        agentId: agent.id,
        companyId: agent.companyId,
        adapterType: agent.adapterType,
        stateJson: {},
      })
      .returning()
      .then((rows) => rows[0]);
  }

  async function updateRuntimeState(
    agent: typeof agents.$inferSelect,
    run: typeof heartbeatRuns.$inferSelect,
    result: AdapterExecutionResult,
    session: { legacySessionId: string | null },
  ): Promise<void> {
    await ensureRuntimeState(agent);
    const usage = result.usage;
    const inputTokens = usage?.inputTokens ?? 0;
    const outputTokens = usage?.outputTokens ?? 0;
    const cachedInputTokens = usage?.cachedInputTokens ?? 0;
    const additionalCostCents = Math.max(0, Math.round((result.costUsd ?? 0) * 100));
    const hasTokenUsage = inputTokens > 0 || outputTokens > 0 || cachedInputTokens > 0;

    await db
      .update(agentRuntimeState)
      .set({
        adapterType: agent.adapterType,
        sessionId: session.legacySessionId,
        lastRunId: run.id,
        lastRunStatus: run.status,
        lastError: result.errorMessage ?? null,
        totalInputTokens: sql`${agentRuntimeState.totalInputTokens} + ${inputTokens}`,
        totalOutputTokens: sql`${agentRuntimeState.totalOutputTokens} + ${outputTokens}`,
        totalCachedInputTokens: sql`${agentRuntimeState.totalCachedInputTokens} + ${cachedInputTokens}`,
        totalCostCents: sql`${agentRuntimeState.totalCostCents} + ${additionalCostCents}`,
        updatedAt: new Date(),
      })
      .where(eq(agentRuntimeState.agentId, agent.id));

    if (additionalCostCents > 0 || hasTokenUsage) {
      await costs.createEvent(agent.companyId, {
        agentId: agent.id,
        provider: result.provider ?? "unknown",
        model: result.model ?? "unknown",
        inputTokens,
        outputTokens,
        costCents: additionalCostCents,
        occurredAt: new Date(),
      });
    }
  }

  return { updateRuntimeState };
}
