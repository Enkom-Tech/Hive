import { describe, it, expect, vi } from "vitest";
import Fastify from "fastify";
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

    const app = Fastify({ logger: false });

    // Register pino-http. It must run after body parsing so that customProps
    // can read req.body/req.query from the raw request. We copy Fastify's parsed
    // body/query onto req.raw in a preHandler so the logger serializer can see them.
    app.addHook("preHandler", (req, reply, done) => {
      const raw = req.raw as typeof req.raw & {
        body?: unknown;
        query?: unknown;
        params?: unknown;
      };
      raw.body = req.body;
      raw.query = req.query;
      raw.params = req.params;
      httpLogger(raw, reply.raw, done);
    });

    app.post("/test", async (_req, reply) => {
      return reply.status(400).send({ error: "bad" });
    });

    await app.ready();
    await app.listen({ port: 0, host: "127.0.0.1" });
    const port = (app.server.address() as { port: number }).port;

    const jwtLike = "abc.def.ghi";
    const apiKeyLike = "super-secret-api-key";

    try {
      await fetch(
        `http://127.0.0.1:${port}/test?token=${encodeURIComponent(jwtLike)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            authorization: `Bearer ${jwtLike}`,
            api_key: apiKeyLike,
            nested: { password: "hunter2" },
          }),
        },
      );
    } finally {
      await app.close();
    }

    await new Promise<void>((resolve) => {
      logger.flush(() => resolve());
    });

    const logFile = path.join(tmpLogDir, "server.log");
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
