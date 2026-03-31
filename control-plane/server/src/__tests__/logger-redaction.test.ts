import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

describe("logger request redaction", () => {
  it("sanitizes secret-like fields from reqBody/reqQuery on 4xx logs", async () => {
    const tmpLogDir = path.join(os.tmpdir(), `hive-logger-test-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    process.env.HIVE_LOG_DIR = tmpLogDir;

    // Import logger after env var is set (logger module resolves log dir at module init time).
    vi.resetModules();
    const { httpLogger, logger } = await import("../middleware/logger.js");

    const app = express();
    app.use(express.json());
    app.use(httpLogger);
    app.post("/test", (_req, res) => {
      res.status(400).json({ error: "bad" });
    });

    const jwtLike = "abc.def.ghi";
    const apiKeyLike = "super-secret-api-key";

    await request(app)
      .post("/test")
      .query({ token: jwtLike })
      .send({
        authorization: `Bearer ${jwtLike}`,
        api_key: apiKeyLike,
        nested: { password: "hunter2" },
      })
      .expect(400);

    await new Promise<void>((resolve) => {
      logger.flush(() => resolve());
    });

    const logFile = path.join(tmpLogDir, "server.log");
    // pino transport may create/write the file slightly after request completion.
    const deadlineMs = Date.now() + 500;
    while (!fs.existsSync(logFile) && Date.now() < deadlineMs) {
      await new Promise<void>((r) => setTimeout(r, 25));
    }

    expect(fs.existsSync(logFile)).toBe(true);
    const logText = fs.readFileSync(logFile, "utf8");

    expect(logText).toContain("***REDACTED***");
    expect(logText).not.toContain(jwtLike);
    expect(logText).not.toContain(apiKeyLike);
    expect(logText).not.toContain("hunter2");
  });
});

