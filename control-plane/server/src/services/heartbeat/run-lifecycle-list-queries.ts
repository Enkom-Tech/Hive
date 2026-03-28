import { and, asc, desc, eq, gt } from "drizzle-orm";
import type { Db } from "@hive/db";
import { heartbeatRunEvents, heartbeatRuns } from "@hive/db";
import { summarizeHeartbeatRunResultJson } from "../heartbeat-run-summary.js";
import { heartbeatRunListColumns } from "./run-lifecycle-list-columns.js";

export function createRunLifecycleListQueries(db: Db) {
  const list = async (companyId: string, agentId?: string, limit?: number) => {
    const query = db
      .select(heartbeatRunListColumns)
      .from(heartbeatRuns)
      .where(
        agentId
          ? and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.agentId, agentId))
          : eq(heartbeatRuns.companyId, companyId),
      )
      .orderBy(desc(heartbeatRuns.createdAt));

    const rows = limit ? await query.limit(limit) : await query;
    return rows.map((row) => ({
      ...row,
      resultJson: summarizeHeartbeatRunResultJson(row.resultJson),
    }));
  };

  const listEvents = (runId: string, afterSeq = 0, limit = 200) =>
    db
      .select()
      .from(heartbeatRunEvents)
      .where(and(eq(heartbeatRunEvents.runId, runId), gt(heartbeatRunEvents.seq, afterSeq)))
      .orderBy(asc(heartbeatRunEvents.seq))
      .limit(Math.max(1, Math.min(limit, 1000)));

  return { list, listEvents };
}
