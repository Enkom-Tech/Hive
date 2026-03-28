import type { Router } from "express";
import { notFound } from "../../errors.js";
import { readSkillMarkdown } from "./read-skill-markdown.js";

export function registerSkillsRoutes(router: Router): void {
  router.get("/skills/index", (_req, res) => {
    res.json({
      skills: [
        { name: "hive", path: "/api/skills/hive" },
        {
          name: "hive-create-agent",
          path: "/api/skills/hive-create-agent",
        },
      ],
    });
  });

  router.get("/skills/:skillName", (req, res) => {
    const skillName = (req.params.skillName as string).trim().toLowerCase();
    const markdown = readSkillMarkdown(skillName);
    if (!markdown) throw notFound("Skill not found");
    res.type("text/markdown").send(markdown);
  });
}
