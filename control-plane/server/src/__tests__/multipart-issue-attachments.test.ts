/// <reference path="../types/fastify.d.ts" />
import { Readable } from "node:stream";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@hive/db";
import { HttpError } from "../errors.js";
import { ZodError } from "zod";
import { issueAttachmentsPlugin } from "../routes/issue-routes/issue-attachments-routes.js";
import { actorBoard } from "./helpers/route-app.js";
import type { Principal } from "@hive/shared";

// ─── Service mocks ────────────────────────────────────────────────────────────

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  listAttachments: vi.fn(),
  getAttachmentById: vi.fn(),
  createAttachment: vi.fn(),
  removeAttachment: vi.fn(),
}));

const mockStorageService = {
  putFile: vi.fn(),
  getObject: vi.fn(),
  deleteObject: vi.fn(),
};

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  hasPermission: vi.fn(),
}));

vi.mock("../services/index.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../services/index.js")>();
  return {
    ...original,
    issueService: () => mockIssueService,
    logActivity: vi.fn(),
  };
});

vi.mock("../services/access.js", () => ({
  accessService: () => mockAccessService,
}));

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function buildApp(principal: Principal | null = actorBoard(["company-1"], { source: "local_implicit" })): Promise<FastifyInstance> {
  const db = {} as unknown as Db;
  const app = Fastify({ logger: false });

  app.addHook("onRequest", async (req) => {
    req.principal = principal;
  });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof HttpError) {
      void reply.status(err.status).send({ error: err.message });
      return;
    }
    if (err instanceof ZodError) {
      void reply.status(400).send({ error: "Validation error", details: err.issues });
      return;
    }
    void reply.status(500).send({ error: "Internal server error" });
  });

  await app.register(issueAttachmentsPlugin, { db, storage: mockStorageService as never });
  await app.ready();
  return app;
}

function buildMultipartBody(
  boundary: string,
  fields: Record<string, string>,
  file?: { fieldname: string; filename: string; contentType: string; data: Buffer },
): Buffer {
  const parts: Buffer[] = [];

  for (const [name, value] of Object.entries(fields)) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
      ),
    );
  }

  if (file) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${file.fieldname}"; filename="${file.filename}"\r\nContent-Type: ${file.contentType}\r\n\r\n`,
      ),
      file.data,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    );
  } else {
    parts.push(Buffer.from(`--${boundary}--\r\n`));
  }

  return Buffer.concat(parts);
}

const SAMPLE_ISSUE = {
  id: "issue-1",
  companyId: "company-1",
  status: "backlog",
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("issueAttachmentsPlugin — GET /api/issues/:id/attachments", () => {
  let app: FastifyInstance;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await app?.close();
  });

  it("returns 404 when issue does not exist", async () => {
    app = await buildApp();
    mockIssueService.getById.mockResolvedValue(null);

    const res = await app.inject({ method: "GET", url: "/api/issues/nonexistent/attachments" });
    expect(res.statusCode).toBe(404);
  });

  it("returns attachment list with contentPath injected", async () => {
    app = await buildApp();
    mockIssueService.getById.mockResolvedValue(SAMPLE_ISSUE);
    mockIssueService.listAttachments.mockResolvedValue([
      { id: "att-1", issueId: "issue-1", originalFilename: "file.png" },
      { id: "att-2", issueId: "issue-1", originalFilename: "doc.pdf" },
    ]);

    const res = await app.inject({ method: "GET", url: "/api/issues/issue-1/attachments" });
    expect(res.statusCode).toBe(200);
    const body = res.json<Array<{ id: string; contentPath: string }>>();
    expect(body).toHaveLength(2);
    expect(body[0].contentPath).toBe("/api/attachments/att-1/content");
    expect(body[1].contentPath).toBe("/api/attachments/att-2/content");
  });
});

describe("issueAttachmentsPlugin — POST /api/companies/:companyId/issues/:issueId/attachments", () => {
  let app: FastifyInstance;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await app?.close();
  });

  it("returns 201 with attachment payload on a valid upload", async () => {
    app = await buildApp();
    mockIssueService.getById.mockResolvedValue(SAMPLE_ISSUE);
    mockStorageService.putFile.mockResolvedValue({
      provider: "local_disk",
      objectKey: "issues/issue-1/file.png",
      contentType: "image/png",
      byteSize: 8,
      sha256: "abc123",
      originalFilename: "file.png",
    });
    mockIssueService.createAttachment.mockResolvedValue({
      id: "att-1",
      issueId: "issue-1",
      issueCommentId: null,
      companyId: "company-1",
      provider: "local_disk",
      objectKey: "issues/issue-1/file.png",
      contentType: "image/png",
      byteSize: 8,
      sha256: "abc123",
      originalFilename: "file.png",
      createdByAgentId: null,
      createdByUserId: null,
    });

    const boundary = "----TestBoundary";
    const body = buildMultipartBody(boundary, {}, {
      fieldname: "file",
      filename: "file.png",
      contentType: "image/png",
      data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/companies/company-1/issues/issue-1/attachments",
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: body,
    });

    expect(res.statusCode).toBe(201);
    const json = res.json<{ id: string; contentPath: string }>();
    expect(json.id).toBe("att-1");
    expect(json.contentPath).toBe("/api/attachments/att-1/content");
  });

  it("returns 404 when issue does not exist", async () => {
    app = await buildApp();
    mockIssueService.getById.mockResolvedValue(null);

    const boundary = "----TestBoundary5";
    const body = buildMultipartBody(boundary, {}, {
      fieldname: "file",
      filename: "file.png",
      contentType: "image/png",
      data: Buffer.from([0x89]),
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/companies/company-1/issues/nonexistent/attachments",
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: body,
    });

    expect(res.statusCode).toBe(404);
  });

  it("returns 422 when issue belongs to a different company", async () => {
    app = await buildApp();
    mockIssueService.getById.mockResolvedValue({ ...SAMPLE_ISSUE, companyId: "other-company" });

    const boundary = "----TestBoundary6";
    const body = buildMultipartBody(boundary, {}, {
      fieldname: "file",
      filename: "file.png",
      contentType: "image/png",
      data: Buffer.from([0x89]),
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/companies/company-1/issues/issue-1/attachments",
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: body,
    });

    expect(res.statusCode).toBe(422);
    expect(res.json<{ error: string }>().error).toMatch(/does not belong to company/);
  });

  it("returns 400 when no file part is present", async () => {
    app = await buildApp();
    mockIssueService.getById.mockResolvedValue(SAMPLE_ISSUE);

    const boundary = "----TestBoundary7";
    const body = buildMultipartBody(boundary, {});

    const res = await app.inject({
      method: "POST",
      url: "/api/companies/company-1/issues/issue-1/attachments",
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: body,
    });

    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toMatch(/Missing file field/);
  });

  it("returns 403 when principal is null (unauthenticated)", async () => {
    app = await buildApp(null);

    const boundary = "----TestBoundary8";
    const body = buildMultipartBody(boundary, {}, {
      fieldname: "file",
      filename: "file.png",
      contentType: "image/png",
      data: Buffer.from([0x89]),
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/companies/company-1/issues/issue-1/attachments",
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: body,
    });

    expect(res.statusCode).toBe(401);
  });
});

describe("issueAttachmentsPlugin — GET /api/attachments/:attachmentId/content", () => {
  let app: FastifyInstance;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await app?.close();
  });

  it("returns 404 when attachment does not exist", async () => {
    app = await buildApp();
    mockIssueService.getAttachmentById.mockResolvedValue(null);

    const res = await app.inject({ method: "GET", url: "/api/attachments/nonexistent/content" });
    expect(res.statusCode).toBe(404);
  });

  it("streams content with correct headers", async () => {
    app = await buildApp();
    mockIssueService.getAttachmentById.mockResolvedValue({
      id: "att-1",
      companyId: "company-1",
      objectKey: "issues/issue-1/file.png",
      contentType: "image/png",
      byteSize: 4,
      originalFilename: "file.png",
    });
    mockStorageService.getObject.mockResolvedValue({
      contentType: "image/png",
      contentLength: 4,
      stream: Readable.from([Buffer.from([0x89, 0x50, 0x4e, 0x47])]),
    });

    const res = await app.inject({ method: "GET", url: "/api/attachments/att-1/content" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/image\/png/);
    expect(res.headers["cache-control"]).toBe("private, max-age=60");
    expect(res.headers["content-disposition"]).toContain("file.png");
  });
});

describe("issueAttachmentsPlugin — DELETE /api/attachments/:attachmentId", () => {
  let app: FastifyInstance;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await app?.close();
  });

  it("returns 404 when attachment does not exist", async () => {
    app = await buildApp();
    mockIssueService.getAttachmentById.mockResolvedValue(null);

    const res = await app.inject({ method: "DELETE", url: "/api/attachments/nonexistent" });
    expect(res.statusCode).toBe(404);
  });

  it("deletes attachment and returns ok", async () => {
    app = await buildApp();
    mockIssueService.getAttachmentById.mockResolvedValue({
      id: "att-1",
      companyId: "company-1",
      objectKey: "issues/issue-1/file.png",
    });
    mockStorageService.deleteObject.mockResolvedValue(undefined);
    mockIssueService.removeAttachment.mockResolvedValue({
      id: "att-1",
      companyId: "company-1",
      issueId: "issue-1",
    });

    const res = await app.inject({ method: "DELETE", url: "/api/attachments/att-1" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });
});
