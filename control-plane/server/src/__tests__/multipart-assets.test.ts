/// <reference path="../types/fastify.d.ts" />
import { Readable } from "node:stream";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@hive/db";
import { HttpError } from "../errors.js";
import { ZodError } from "zod";
import { assetsPlugin } from "../routes/assets.js";
import { actorBoard } from "./helpers/route-app.js";
import type { Principal } from "@hive/shared";

// ─── Service mocks ────────────────────────────────────────────────────────────

const mockAssetService = vi.hoisted(() => ({
  create: vi.fn(),
  getById: vi.fn(),
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
    assetService: () => mockAssetService,
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

  await app.register(assetsPlugin, { db, storage: mockStorageService as never });
  await app.ready();
  return app;
}

function buildMultipartBody(
  boundary: string,
  fields: Record<string, string>,
  file: { fieldname: string; filename: string; contentType: string; data: Buffer },
): Buffer {
  const parts: Buffer[] = [];

  for (const [name, value] of Object.entries(fields)) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
      ),
    );
  }

  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${file.fieldname}"; filename="${file.filename}"\r\nContent-Type: ${file.contentType}\r\n\r\n`,
    ),
    file.data,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  );

  return Buffer.concat(parts);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("assetsPlugin — POST /api/companies/:companyId/assets/images", () => {
  let app: FastifyInstance;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await app?.close();
  });

  it("returns 201 with asset payload on a valid PNG upload", async () => {
    app = await buildApp();
    const boundary = "----TestBoundary";
    const pngMagic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

    mockStorageService.putFile.mockResolvedValue({
      provider: "local_disk",
      objectKey: "assets/general/test.png",
      contentType: "image/png",
      byteSize: pngMagic.length,
      sha256: "abc123",
      originalFilename: "test.png",
    });
    mockAssetService.create.mockResolvedValue({
      id: "asset-1",
      companyId: "company-1",
      provider: "local_disk",
      objectKey: "assets/general/test.png",
      contentType: "image/png",
      byteSize: pngMagic.length,
      sha256: "abc123",
      originalFilename: "test.png",
      createdByAgentId: null,
      createdByUserId: null,
      createdAt: new Date("2026-01-01"),
      updatedAt: new Date("2026-01-01"),
    });

    const body = buildMultipartBody(boundary, {}, {
      fieldname: "file",
      filename: "test.png",
      contentType: "image/png",
      data: pngMagic,
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/companies/company-1/assets/images",
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: body,
    });

    expect(res.statusCode).toBe(201);
    const json = res.json<{ assetId: string; contentPath: string }>();
    expect(json.assetId).toBe("asset-1");
    expect(json.contentPath).toBe("/api/assets/asset-1/content");
    expect(mockStorageService.putFile).toHaveBeenCalledWith(
      expect.objectContaining({ companyId: "company-1", contentType: "image/png" }),
    );
  });

  it("returns 422 when content-type is not an allowed image type", async () => {
    app = await buildApp();
    const boundary = "----TestBoundary2";

    const body = buildMultipartBody(boundary, {}, {
      fieldname: "file",
      filename: "doc.pdf",
      contentType: "application/pdf",
      data: Buffer.from("%PDF-1.4"),
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/companies/company-1/assets/images",
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: body,
    });

    expect(res.statusCode).toBe(422);
    expect(res.json<{ error: string }>().error).toMatch(/Unsupported file type/);
    expect(mockStorageService.putFile).not.toHaveBeenCalled();
  });

  it("returns 400 when no file part is present", async () => {
    app = await buildApp();
    const boundary = "----TestBoundary3";
    const body = Buffer.from(`--${boundary}--\r\n`);

    const res = await app.inject({
      method: "POST",
      url: "/api/companies/company-1/assets/images",
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: body,
    });

    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toMatch(/Missing file field/);
  });

  it("returns 403 when principal is null (unauthenticated)", async () => {
    app = await buildApp(null);
    const boundary = "----TestBoundary4";
    const body = buildMultipartBody(boundary, {}, {
      fieldname: "file",
      filename: "test.png",
      contentType: "image/png",
      data: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/companies/company-1/assets/images",
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: body,
    });

    expect(res.statusCode).toBe(401);
  });
});

describe("assetsPlugin — GET /api/assets/:assetId/content", () => {
  let app: FastifyInstance;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await app?.close();
  });

  it("returns 404 when asset does not exist", async () => {
    app = await buildApp();
    mockAssetService.getById.mockResolvedValue(null);

    const res = await app.inject({ method: "GET", url: "/api/assets/nonexistent/content" });
    expect(res.statusCode).toBe(404);
  });

  it("streams asset content with correct headers", async () => {
    app = await buildApp();
    mockAssetService.getById.mockResolvedValue({
      id: "asset-1",
      companyId: "company-1",
      objectKey: "assets/general/test.png",
      contentType: "image/png",
      byteSize: 8,
      originalFilename: "test.png",
    });
    mockStorageService.getObject.mockResolvedValue({
      contentType: "image/png",
      contentLength: 8,
      stream: Readable.from([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])]),
    });

    const res = await app.inject({ method: "GET", url: "/api/assets/asset-1/content" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/image\/png/);
    expect(res.headers["cache-control"]).toBe("private, max-age=60");
    expect(res.headers["content-disposition"]).toContain("test.png");
  });
});
