import type { Db } from "@hive/db";
import { costService, heartbeatService, issueService } from "../../services/index.js";

export type WorkerApiRoutesContext = {
  db: Db;
  strictSecretsMode: boolean;
  costs: ReturnType<typeof costService>;
  issues: ReturnType<typeof issueService>;
  heartbeat: ReturnType<typeof heartbeatService>;
};
