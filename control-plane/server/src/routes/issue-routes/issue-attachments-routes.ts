import type { FastifyInstance } from "fastify";
import fastifyMultipart from "@fastify/multipart";
import { createIssueAttachmentMetadataSchema } from "@hive/shared";
import type { Db } from "@hive/db";
import { assertCompanyPermission, assertCompanyRead, getActorInfo } from "../authz.js";
import { issueService, logActivity } from "../../services/index.js";
import { logger } from "../../middleware/logger.js";
import { isAllowedContentType, getMaxAttachmentBytes } from "../../attachment-types.js";
import type { StorageService } from "../../storage/types.js";

function withContentPath<T extends { id: string }>(attachment: T) {
  return { ...attachment, contentPath: `/api/attachments/${attachment.id}/content` };
}

/**
 * Fastify-native issue attachments plugin.
 *
 * Handles upload, listing, content retrieval, and deletion of issue
 * attachments.  Uses @fastify/multipart with req.parts() to consume all form
 * parts in a single pass, regardless of field order.  The single file part is
 * buffered in memory, matching the multer memoryStorage behaviour of the
 * Express counterpart.
 */
export async function issueAttachmentsPlugin(
  fastify: FastifyInstance,
  opts: { db: Db; storage: StorageService },
): Promise<void> {
  const { db, storage } = opts;
  const svc = issueService(db);

  await fastify.register(fastifyMultipart, {
    limits: { fileSize: getMaxAttachmentBytes(), files: 1 },
  });

  fastify.get<{ Params: { id: string } }>(
    "/api/issues/:id/attachments",
    async (req, reply) => {
      const issueId = req.params.id;
      const issue = await svc.getById(issueId);
      if (!issue) {
        return reply.status(404).send({ error: "Issue not found" });
      }
      await assertCompanyRead(db, req, issue.companyId);
      const attachments = await svc.listAttachments(issueId);
      return reply.send(attachments.map(withContentPath));
    },
  );

  fastify.post<{ Params: { companyId: string; issueId: string } }>(
    "/api/companies/:companyId/issues/:issueId/attachments",
    async (req, reply) => {
      const { companyId, issueId } = req.params;
      await assertCompanyPermission(db, req, companyId, "issues:write");
      const issue = await svc.getById(issueId);
      if (!issue) {
        return reply.status(404).send({ error: "Issue not found" });
      }
      if (issue.companyId !== companyId) {
        return reply.status(422).send({ error: "Issue does not belong to company" });
      }

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
              return reply.status(422).send({ error: `Attachment exceeds ${getMaxAttachmentBytes()} bytes` });
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
      if (!isAllowedContentType(contentType)) {
        return reply.status(422).send({ error: `Unsupported attachment type: ${contentType || "unknown"}` });
      }
      if (filePart.buffer.length <= 0) {
        return reply.status(422).send({ error: "Attachment is empty" });
      }

      const parsedMeta = createIssueAttachmentMetadataSchema.safeParse(fields);
      if (!parsedMeta.success) {
        return reply.status(400).send({ error: "Invalid attachment metadata", details: parsedMeta.error.issues });
      }

      const actor = getActorInfo(req);
      const stored = await storage.putFile({
        companyId,
        namespace: `issues/${issueId}`,
        originalFilename: filePart.filename || null,
        contentType,
        body: filePart.buffer,
      });

      const attachment = await svc.createAttachment({
        issueId,
        issueCommentId: parsedMeta.data.issueCommentId ?? null,
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
        action: "issue.attachment_added",
        entityType: "issue",
        entityId: issueId,
        details: {
          attachmentId: attachment.id,
          originalFilename: attachment.originalFilename,
          contentType: attachment.contentType,
          byteSize: attachment.byteSize,
        },
      });

      return reply.status(201).send(withContentPath(attachment));
    },
  );

  fastify.get<{ Params: { attachmentId: string } }>(
    "/api/attachments/:attachmentId/content",
    async (req, reply) => {
      const { attachmentId } = req.params;
      const attachment = await svc.getAttachmentById(attachmentId);
      if (!attachment) {
        return reply.status(404).send({ error: "Attachment not found" });
      }
      await assertCompanyRead(db, req, attachment.companyId);

      const object = await storage.getObject(attachment.companyId, attachment.objectKey);
      const filename = attachment.originalFilename ?? "attachment";
      return reply
        .header("Content-Type", attachment.contentType || object.contentType || "application/octet-stream")
        .header("Content-Length", String(attachment.byteSize || object.contentLength || 0))
        .header("Cache-Control", "private, max-age=60")
        .header("Content-Disposition", `inline; filename="${filename.replaceAll('"', '')}"`)
        .send(object.stream);
    },
  );

  fastify.delete<{ Params: { attachmentId: string } }>(
    "/api/attachments/:attachmentId",
    async (req, reply) => {
      const { attachmentId } = req.params;
      const attachment = await svc.getAttachmentById(attachmentId);
      if (!attachment) {
        return reply.status(404).send({ error: "Attachment not found" });
      }
      await assertCompanyPermission(db, req, attachment.companyId, "issues:write");

      try {
        await storage.deleteObject(attachment.companyId, attachment.objectKey);
      } catch (err) {
        logger.warn({ err, attachmentId }, "storage delete failed while removing attachment");
      }

      const removed = await svc.removeAttachment(attachmentId);
      if (!removed) {
        return reply.status(404).send({ error: "Attachment not found" });
      }

      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId: removed.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "issue.attachment_removed",
        entityType: "issue",
        entityId: removed.issueId,
        details: {
          attachmentId: removed.id,
        },
      });

      return reply.send({ ok: true });
    },
  );
}
