/// <reference path="../types/fastify.d.ts" />
import type { FastifyInstance } from "fastify";
import type { Db } from "@hive/db";
import { AGENT_ICON_NAMES } from "@hive/shared";
import { forbidden } from "../errors.js";
import { listServerAdapters } from "../adapters/index.js";
import { agentService } from "../services/agents.js";

function hasCreatePermission(agent: { role: string; permissions: Record<string, unknown> | null | undefined }) {
  if (!agent.permissions || typeof agent.permissions !== "object") return false;
  return Boolean((agent.permissions as Record<string, unknown>).canCreateAgents);
}

export async function llmPlugin(fastify: FastifyInstance, opts: { db: Db }): Promise<void> {
  const agentsSvc = agentService(opts.db);

  async function assertCanRead(fastifyReq: import("fastify").FastifyRequest) {
    const p = fastifyReq.principal ?? null;
    if (p?.type === "user" || p?.type === "system") return;
    if (p?.type !== "agent" || !p.id) {
      throw forbidden("Board or permitted agent authentication required");
    }
    const actorAgent = await agentsSvc.getById(p.id);
    if (!actorAgent || !hasCreatePermission(actorAgent)) {
      throw forbidden("Missing permission to read agent configuration reflection");
    }
  }

  fastify.get("/llms/agent-configuration.txt", async (req, reply) => {
    await assertCanRead(req);
    const adapters = listServerAdapters().sort((a, b) => a.type.localeCompare(b.type));
    const lines = [
      "# Hive Agent Configuration Index",
      "",
      "Installed adapters:",
      ...adapters.map((adapter) => `- ${adapter.type}: /llms/agent-configuration/${adapter.type}.txt`),
      "",
      "Related API endpoints:",
      "- GET /api/companies/:companyId/agent-configurations",
      "- GET /api/agents/:id/configuration",
      "- POST /api/companies/:companyId/agent-hires",
      "",
      "Agent identity references:",
      "- GET /llms/agent-icons.txt",
      "",
      "Notes:",
      "- Sensitive values are redacted in configuration read APIs.",
      "- New hires may be created in pending_approval state depending on company settings.",
      "",
    ];
    return reply.type("text/plain").send(lines.join("\n"));
  });

  fastify.get("/llms/agent-icons.txt", async (req, reply) => {
    await assertCanRead(req);
    const lines = [
      "# Hive Agent Icon Names",
      "",
      "Set the `icon` field on hire/create payloads to one of:",
      ...AGENT_ICON_NAMES.map((name) => `- ${name}`),
      "",
      "Example:",
      '{ "name": "SearchOps", "role": "researcher", "icon": "search" }',
      "",
    ];
    return reply.type("text/plain").send(lines.join("\n"));
  });

  fastify.get<{ Params: { adapterType: string } }>(
    "/llms/agent-configuration/:adapterType.txt",
    async (req, reply) => {
      await assertCanRead(req);
      const { adapterType } = req.params;
      const adapter = listServerAdapters().find((entry) => entry.type === adapterType);
      if (!adapter) {
        return reply.status(404).type("text/plain").send(`Unknown adapter type: ${adapterType}`);
      }
      return reply
        .type("text/plain")
        .send(
          adapter.agentConfigurationDoc ??
            `# ${adapterType} agent configuration\n\nNo adapter-specific documentation registered.`,
        );
    },
  );
}
