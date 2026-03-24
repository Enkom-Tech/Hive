#!/usr/bin/env node
/**
 * Fails if removed HTTP paths or renamed symbols reappear in production source.
 * Test files may still mention legacy strings when asserting 404 — those are excluded.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");

const SCAN_ROOTS = [
  join(ROOT, "server/src"),
  join(ROOT, "ui/src"),
  join(ROOT, "cli/src"),
  join(ROOT, "packages/db/src"),
];

const FORBIDDEN = [
  { pattern: /\/workers\/overview/, label: "removed GET .../workers/overview" },
  { pattern: /worker-enrollment-tokens/, label: "removed .../worker-enrollment-tokens" },
  { pattern: /\blistWorkerDeploymentOverview\b/, label: "renamed listWorkerDeploymentOverview" },
  { pattern: /\bWorkerDeploymentOverview\b/, label: "renamed WorkerDeploymentOverview" },
  { pattern: /\bworkerEnrollmentTokens\b/, label: "renamed workerEnrollmentTokens table export" },
];

function shouldSkipFile(relPath) {
  if (relPath.includes(`${join("server", "src", "__tests__")}`) || relPath.includes("/__tests__/")) {
    return true;
  }
  const base = relPath.split(/[/\\]/).pop() ?? "";
  if (/\.test\.tsx?$/.test(base)) return true;
  return false;
}

function walk(dir, out) {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) {
      if (ent.name === "node_modules" || ent.name === "dist") continue;
      walk(p, out);
    } else if (/\.(ts|tsx)$/.test(ent.name)) {
      out.push(p);
    }
  }
}

function main() {
  const files = [];
  for (const root of SCAN_ROOTS) {
    try {
      if (!statSync(root).isDirectory()) continue;
    } catch {
      continue;
    }
    walk(root, files);
  }

  const hits = [];
  for (const abs of files) {
    const rel = relative(ROOT, abs);
    if (shouldSkipFile(rel)) continue;
    let text;
    try {
      text = readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    for (const { pattern, label } of FORBIDDEN) {
      if (pattern.test(text)) {
        hits.push({ rel, label });
      }
    }
  }

  if (hits.length > 0) {
    console.error("ERROR: Legacy drone/agent API identifiers found in production source:\n");
    for (const h of hits) {
      console.error(`  ${h.rel}: ${h.label}`);
    }
    console.error("\nRemove or rename these references (tests asserting 404 are fine; they live under __tests__ or *.test.ts).");
    process.exit(1);
  }

  console.log("ok  No legacy drone API identifiers in production source.");
  process.exit(0);
}

main();
