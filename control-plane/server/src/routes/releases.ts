import type { FastifyInstance } from "fastify";
import { APP_VERSION } from "@hive/shared/version";
import { getReleaseCheck } from "../services/release-check.js";

export async function releasesPlugin(fastify: FastifyInstance): Promise<void> {
  fastify.get("/releases/check", async (_req, reply) => {
    try {
      const payload = await getReleaseCheck(APP_VERSION);
      return reply.send(payload);
    } catch {
      return reply.send({ currentVersion: APP_VERSION });
    }
  });
}
