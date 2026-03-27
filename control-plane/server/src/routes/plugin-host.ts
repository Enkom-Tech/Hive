import { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import type { Db } from "@hive/db";
import { validate } from "../middleware/validate.js";
import { unauthorized } from "../errors.js";
import { pluginRegistryService } from "../services/plugins.js";

const rpcBodySchema = z.object({
  instanceId: z.string().uuid(),
  method: z.literal("ping"),
});

/**
 * Internal Bearer-authenticated RPC surface for out-of-process plugins.
 * Set `HIVE_PLUGIN_HOST_SECRET` and call `POST /api/internal/plugin-host/rpc`.
 */
export function pluginHostRoutes(
  db: Db,
  opts: { hostSecret: string },
): Router {
  const router = Router();
  const svc = pluginRegistryService(db);

  function requireHostSecret(req: Request, _res: Response, next: NextFunction): void {
    const h = req.headers.authorization;
    const tok =
      typeof h === "string" && h.toLowerCase().startsWith("bearer ") ? h.slice(7).trim() : "";
    if (!tok || tok !== opts.hostSecret) {
      next(unauthorized("Invalid plugin host token"));
      return;
    }
    next();
  }

  router.post("/rpc", requireHostSecret, validate(rpcBodySchema), async (req, res, next) => {
    try {
      const { instanceId, method } = req.body as z.infer<typeof rpcBodySchema>;
      const row = await svc.getInstanceForRpc(instanceId);
      if (!row || !row.enabled) {
        res.status(404).json({ ok: false, error: "Plugin instance not found or disabled" });
        return;
      }
      const caps = svc.parseCapabilitiesJson(row.capabilitiesJson);
      if (!caps.includes("rpc.ping")) {
        res.status(403).json({ ok: false, error: "Missing rpc.ping capability" });
        return;
      }
      if (method === "ping") {
        res.json({ ok: true, method: "ping" });
        return;
      }
      res.status(400).json({ ok: false, error: "Unsupported method" });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
