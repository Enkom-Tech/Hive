import type { FastifyInstance } from "fastify";
import { notFound } from "../../errors.js";
import { readSkillMarkdown } from "./read-skill-markdown.js";

export function registerSkillsRoutesF(fastify: FastifyInstance): void {
  fastify.get("/api/skills/index", (_req, reply) => {
    return reply.send({ skills: [{ name: "hive", path: "/api/skills/hive" }, { name: "hive-create-agent", path: "/api/skills/hive-create-agent" }] });
  });

  fastify.get<{ Params: { skillName: string } }>("/api/skills/:skillName", (req, reply) => {
    const skillName = req.params.skillName.trim().toLowerCase();
    const markdown = readSkillMarkdown(skillName);
    if (!markdown) throw notFound("Skill not found");
    return reply.type("text/markdown").send(markdown);
  });
}
