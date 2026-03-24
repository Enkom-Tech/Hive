import { execSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const scriptPath = path.resolve(__dirname, "../../../scripts/check-forbidden-tokens.mjs");

describe("forbidden token check", () => {
  it("exits 0 when no forbidden tokens are found", () => {
    const repoRoot = path.resolve(__dirname, "../../..");
    const result = execSync(`node "${scriptPath}"`, {
      encoding: "utf8",
      cwd: repoRoot,
      stdio: ["pipe", "pipe", "pipe"],
    });
    expect(result).toContain("ok");
  });

  it.skipIf(process.platform === "win32")("exits 1 and reports when a forbidden token is found in tracked files", async () => {
    const os = await import("node:os");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hive-forbidden-tokens-test-"));
    try {
      execSync("git init", { cwd: tmpDir, stdio: "ignore" });
      execSync("git config user.email test@example.com", { cwd: tmpDir, stdio: "ignore" });
      execSync("git config user.name Test", { cwd: tmpDir, stdio: "ignore" });
      const hooksDir = path.join(tmpDir, ".git", "hooks");
      fs.mkdirSync(hooksDir, { recursive: true });
      fs.writeFileSync(path.join(hooksDir, "forbidden-tokens.txt"), "secret-token-xyz\n", "utf8");
      fs.writeFileSync(path.join(tmpDir, "file.txt"), "content with secret-token-xyz inside\n", "utf8");
      execSync("git add file.txt", { cwd: tmpDir, stdio: "ignore" });
      execSync("git commit -m initial", { cwd: tmpDir, stdio: "ignore" });

      const out = spawnSync("node", [scriptPath], {
        encoding: "utf8",
        cwd: tmpDir,
        stdio: ["pipe", "pipe", "pipe"],
      });
      expect(out.status).toBe(1);
      const stderr = String(out.stderr ?? "");
      const stdout = String(out.stdout ?? "");
      expect(stderr + stdout).toContain("ERROR");
      expect(stderr + stdout).toContain("secret-token-xyz");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
