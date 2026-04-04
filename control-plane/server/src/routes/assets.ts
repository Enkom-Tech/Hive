import type { FastifyInstance } from "fastify";
import fastifyMultipart from "@fastify/multipart";
import type { Db } from "@hive/db";
import { createAssetImageMetadataSchema } from "@hive/shared";
import type { StorageService } from "../storage/types.js";
import { getMaxAttachmentBytes } from "../attachment-types.js";
import { assetService, logActivity } from "../services/index.js";
import { assertCompanyPermission, assertCompanyRead, getActorInfo } from "./authz.js";

const ALLOWED_IMAGE_CONTENT_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
  "image/gif",
]);

export async function assetsPlugin(
  fastify: FastifyInstance,
  opts: { db: Db; storage: StorageService },
): Promise<void> {
  const { db, storage } = opts;
  const svc = assetService(db);

  await fastify.register(fastifyMultipart, {
    limits: { fileSize: getMaxAttachmentBytes(), files: 1 },
  });

  fastify.post<{ Params: { companyId: string } }>(
    "/api/companies/:companyId/assets/images",
    async (req, reply) => {
      const { companyId } = req.params;
      await assertCompanyPermission(db, req, companyId, "issues:write");

      const fields: Record<string, string> = {};
      let filePart: { buffer: Buffer; filename: string; mimetype: string } | null = null;

      for await (const part of req.parts()) {
        if (part.type === "file") {
          let buffer: Buffer;
          try {
            buffer = await part.toBuffer();
          } catch (err: unknown) {
            const e = err as { code?: string };
            if (e?.code === "FST_REQ_FILE_TOO_LARGE") {
              return reply.status(422).send({ error: `File exceeds ${getMaxAttachmentBytes()} bytes` });
            }
            throw err;
          }
          filePart = { buffer, filename: part.filename, mimetype: part.mimetype };
        } else {
          fields[part.fieldname] = part.value as string;
        }
      }

      if (!filePart) {
        return reply.status(400).send({ error: "Missing file field 'file'" });
      }

      const contentType = (filePart.mimetype || "").toLowerCase();
      if (!ALLOWED_IMAGE_CONTENT_TYPES.has(contentType)) {
        return reply.status(422).send({ error: `Unsupported file type: ${contentType || "unknown"}` });
      }
      if (filePart.buffer.length <= 0) {
        return reply.status(422).send({ error: "Image is empty" });
      }

      const parsedMeta = createAssetImageMetadataSchema.safeParse(fields);
      if (!parsedMeta.success) {
        return reply.status(400).send({ error: "Invalid image metadata", details: parsedMeta.error.issues });
      }

      const namespaceSuffix = parsedMeta.data.namespace ?? "general";
      const actor = getActorInfo(req);
      const stored = await storage.putFile({
        companyId,
        namespace: `assets/${namespaceSuffix}`,
        originalFilename: filePart.filename || null,
        contentType,
        body: filePart.buffer,
      });

      const asset = await svc.create(companyId, {
        provider: stored.provider,
        objectKey: stored.objectKey,
        contentType: stored.contentType,
        byteSize: stored.byteSize,
        sha256: stored.sha256,
        originalFilename: stored.originalFilename,
        createdByAgentId: actor.agentId,
        createdByUserId: actor.actorType === "user" ? actor.actorId : null,
      });

      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "asset.created",
        entityType: "asset",
        entityId: asset.id,
        details: {
          originalFilename: asset.originalFilename,
          contentType: asset.contentType,
          byteSize: asset.byteSize,
        },
      });

      return reply.status(201).send({
        assetId: asset.id,
        companyId: asset.companyId,
        provider: asset.provider,
        objectKey: asset.objectKey,
        contentType: asset.contentType,
        byteSize: asset.byteSize,
        sha256: asset.sha256,
        originalFilename: asset.originalFilename,
        createdByAgentId: asset.createdByAgentId,
        createdByUserId: asset.createdByUserId,
        createdAt: asset.createdAt,
        updatedAt: asset.updatedAt,
        contentPath: `/api/assets/${asset.id}/content`,
      });
    },
  );

  fastify.get<{ Params: { assetId: string } }>(
    "/api/assets/:assetId/content",
    async (req, reply) => {
      const { assetId } = req.params;
      const asset = await svc.getById(assetId);
      if (!asset) {
        return reply.status(404).send({ error: "Asset not found" });
      }
      await assertCompanyRead(db, req, asset.companyId);

      const object = await storage.getObject(asset.companyId, asset.objectKey);
      const filename = asset.originalFilename ?? "asset";
      return reply
        .header("Content-Type", asset.contentType || object.contentType || "application/octet-stream")
        .header("Content-Length", String(asset.byteSize || object.contentLength || 0))
        .header("Cache-Control", "private, max-age=60")
        .header("Content-Disposition", `inline; filename="${filename.replaceAll('"', '')}"`)
        .send(object.stream);
    },
  );
}

