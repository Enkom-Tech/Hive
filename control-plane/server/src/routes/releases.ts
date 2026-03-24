import { Router } from "express";
import { APP_VERSION } from "@hive/shared/version";
import { getReleaseCheck } from "../services/release-check.js";

export function releaseRoutes() {
  const router = Router();

  router.get("/check", async (_req, res) => {
    try {
      const payload = await getReleaseCheck(APP_VERSION);
      res.json(payload);
    } catch {
      res.json({ currentVersion: APP_VERSION });
    }
  });

  return router;
}
