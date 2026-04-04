import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Db } from "@hive/db";
import { authAccounts, authUsers } from "@hive/db";
import { hashPassword } from "better-auth/crypto";
import { z } from "zod";
import { conflict, notFound } from "../errors.js";
import { assertInstanceAdmin } from "./authz.js";

const createInstanceUserBodySchema = z.object({
  email: z.string().email(),
  name: z.string().min(1).max(200).trim(),
  password: z.string().min(8).max(256),
});

export async function instancePlugin(
  fastify: FastifyInstance,
  opts: { db: Db; deploymentMode: import("@hive/shared").DeploymentMode },
): Promise<void> {
  const { db, deploymentMode } = opts;

  fastify.post("/api/instance/users", async (req, reply) => {
    if (deploymentMode !== "authenticated") throw notFound("Not found");
    assertInstanceAdmin(req);

    const parsed = createInstanceUserBodySchema.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: "Invalid body", details: parsed.error.issues });

    const email = parsed.data.email.trim().toLowerCase();
    const { name, password } = parsed.data;

    const existing = await db
      .select({ id: authUsers.id })
      .from(authUsers)
      .where(eq(authUsers.email, email))
      .then((rows) => rows[0] ?? null);
    if (existing) throw conflict("A user with this email already exists");

    const userId = randomUUID();
    const accountId = randomUUID();
    const now = new Date();
    const passwordHash = await hashPassword(password);

    await db.transaction(async (tx) => {
      await tx.insert(authUsers).values({ id: userId, name, email, emailVerified: true, image: null, createdAt: now, updatedAt: now });
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

    return reply.status(201).send({ id: userId, email, name });
  });
}
