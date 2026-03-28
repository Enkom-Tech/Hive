import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const raw = fs.readFileSync(path.join(__dirname, "_drone_overview_body.txt"), "utf8");
const lines = raw.split("\n");
const innerLines = lines.slice(1);
const dedented = innerLines
  .map((line) => (line.startsWith("      ") ? line.slice(4) : line))
  .join("\n");

const header = `import { and, desc, eq, gt, isNull, ne, sql } from "drizzle-orm";
import type { Db } from "@hive/db";
import {
  agents,
  managedWorkerLinkEnrollmentTokens,
  workerInstanceAgents,
  workerInstances,
} from "@hive/db";
import { getConnectedManagedWorkerAgentIdsForCompany, isWorkerInstanceConnected } from "../../workers/worker-link.js";
import { parseDroneFromAgentMetadata } from "../../workers/worker-hello.js";
import { isPgUndefinedColumnError } from "./pg-errors.js";

/** Subset of fields used by the drone board overview (matches agent row normalization). */
export type DroneBoardAgentNormalized = {
  id: string;
  name: string;
  urlKey: string;
  status: string;
  lastHeartbeatAt: Date | string | null;
  metadata: unknown;
  workerPlacementMode?: string | null;
  operationalPosture?: string | null;
  role: string;
  adapterType: string;
};

export async function listDroneBoardAgentOverview(
  db: Db,
  normalizeAgentRow: (row: typeof agents.$inferSelect) => DroneBoardAgentNormalized,
  companyId: string,
) {
`;

const out = `${header}${dedented}\n}\n`;
fs.writeFileSync(path.join(__dirname, "drone-board-overview.ts"), out);
fs.unlinkSync(path.join(__dirname, "_drone_overview_body.txt"));
fs.unlinkSync(path.join(__dirname, "assemble-drone-overview.mjs"));
