import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SKILL_NAME_TO_DIR: Record<string, string> = {
  hive: "hive",
  "hive-create-agent": "hive-create-agent",
  squadron: "hive",
  "squadron-create-agent": "hive-create-agent",
};

/** Resolves SKILL.md paths from server/src/routes/access-routes/ (dev) or dist (publish). */
export function readSkillMarkdown(skillName: string): string | null {
  const normalized = skillName.trim().toLowerCase();
  const dir = SKILL_NAME_TO_DIR[normalized];
  if (!dir) return null;
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(moduleDir, "../../../skills", dir, "SKILL.md"),
    path.resolve(moduleDir, "../../../../skills", dir, "SKILL.md"),
    path.resolve(process.cwd(), "skills", dir, "SKILL.md"),
  ];
  for (const skillPath of candidates) {
    try {
      return fs.readFileSync(skillPath, "utf8");
    } catch {
      // Continue to next candidate.
    }
  }
  return null;
}
