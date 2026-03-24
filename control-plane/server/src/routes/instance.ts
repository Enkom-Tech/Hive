import { Router } from "express";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { Db } from "@hive/db";
import { authAccounts, authUsers } from "@hive/db";
import { hashPassword } from "better-auth/crypto";
import type { DeploymentMode } from "@hive/shared";
import { z } from "zod";
import { conflict, notFound } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { assertInstanceAdmin } from "./authz.js";

const createInstanceUserBodySchema = z.object({
  email: z.string().email(),
  name: z.string().min(1).max(200).trim(),
  password: z.string().min(8).max(256),
});

export function instanceRoutes(
  db: Db,
  opts: { deploymentMode: DeploymentMode },
) {
  const router = Router();

  router.post("/users", validate(createInstanceUserBodySchema), async (req, res) => {
    if (opts.deploymentMode !== "authenticated") {
      throw notFound("Not found");
    }
    assertInstanceAdmin(req);

    const email = req.body.email.trim().toLowerCase();
    const name = req.body.name as string;
    const password = req.body.password as string;

    const existing = await db
      .select({ id: authUsers.id })
      .from(authUsers)
      .where(eq(authUsers.email, email))
      .then((rows) => rows[0] ?? null);
    if (existing) {
      throw conflict("A user with this email already exists");
    }

    const userId = randomUUID();
    const accountId = randomUUID();
    const now = new Date();
    const passwordHash = await hashPassword(password);

    await db.transaction(async (tx) => {
      await tx.insert(authUsers).values({
        id: userId,
        name,
        email,
        emailVerified: true,
        image: null,
        createdAt: now,
        updatedAt: now,
      });
      await tx.insert(authAccounts).values({
        id: accountId,
        accountId: email,
        providerId: "credential",
        userId,
        accessToken: null,
        refreshToken: null,
        idToken: null,
        accessTokenExpiresAt: null,
        refreshTokenExpiresAt: null,
        scope: null,
        password: passwordHash,
        createdAt: now,
        updatedAt: now,
      });
    });

    res.status(201).json({
      id: userId,
      email,
      name,
    });
  });

  return router;
}
