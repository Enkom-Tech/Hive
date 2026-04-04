import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@hive/db";
import { createRouteTestFastify, actorBoard, actorAgent } from "./helpers/route-app.js";
import { assetsPlugin } from "../routes/assets.js";
import type { StorageService } from "../storage/types.js";

const mockAssetService = vi.hoisted(() => ({
  getById: vi.fn(),
  create: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());

const mockStorage = {
  provider: "local_disk" as const,
  putFile: vi.fn<StorageService["putFile"]>(),
  getObject: vi.fn<StorageService["getObject"]>(),
  headObject: vi.fn(),
  deleteObject: vi.fn<StorageService["deleteObject"]>(),
} satisfies StorageService;

vi.mock("../services/index.js", () => ({
  assetService: () => mockAssetService,
  logActivity: (...args: unknown[]) => mockLogActivity(...args),
}));

const company1 = "company-1";
const company2 = "company-2";
const assetId = "asset-uuid-1";
const assetPayload = {
  id: assetId,
  companyId: company1,
  objectKey: "key-1",
  contentType: "image/png",
  byteSize: 10,
  originalFilename: "test.png",
};

describe("assets route", () => {
  const db = {} as unknown as Db;

  beforeEach(() => {
    vi.clearAllMocks();
    mockLogActivity.mockResolvedValue(undefined);
    mockStorage.putFile.mockResolvedValue({
      provider: "local_disk",
      objectKey: "key-1",
      contentType: "image/png",
      byteSize: 1,
      sha256: "abc",
      originalFilename: null,
    });
    mockStorage.getObject.mockImplementation(() => {
      const stream = new PassThrough();
      stream.write(Buffer.from("x"));
      stream.end();
      return Promise.resolve({
        stream,
        contentType: "image/png",
        contentLength: 1,
      });
    });
  });

  describe("GET /api/assets/:assetId/content", () => {
    it("returns 404 when asset not found", async () => {
      mockAssetService.getById.mockResolvedValue(null);
      const app = await createRouteTestFastify({
        plugin: (f) => assetsPlugin(f, { db, storage: mockStorage }),
        principal: actorBoard([company1]),
      });
      const res = await app.inject({ method: "GET", url: `/api/assets/${assetId}/content` });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ error: "Asset not found" });
      expect(mockStorage.getObject).not.toHaveBeenCalled();
      await app.close();
    });

    it("returns 403 when asset belongs to company actor cannot access", async () => {
      mockAssetService.getById.mockResolvedValue(assetPayload);
      const app = await createRouteTestFastify({
        plugin: (f) => assetsPlugin(f, { db, storage: mockStorage }),
        principal: actorBoard([company2]),
      });
      const res = await app.inject({ method: "GET", url: `/api/assets/${assetId}/content` });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ error: expect.any(String) });
      await app.close();
    });
  });

  describe("POST /api/companies/:companyId/assets/images", () => {
    const minimalPng = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    );

    function buildMultipartBody(fileBuffer: Buffer, boundary: string): Buffer {
      const parts = [
        `--${boundary}\r\n`,
        `Content-Disposition: form-data; name="file"; filename="x.png"\r\n`,
        `Content-Type: image/png\r\n`,
        `\r\n`,
      ];
      const suffix = `\r\n--${boundary}--\r\n`;
      return Buffer.concat([
        Buffer.from(parts.join("")),
        fileBuffer,
        Buffer.from(suffix),
      ]);
    }

    it("returns 201 with asset on success", async () => {
      const created = {
        ...assetPayload,
        createdAt: new Date(),
        updatedAt: new Date(),
        createdByAgentId: null,
        createdByUserId: "user-1",
        provider: "local_disk" as const,
        sha256: "abc",
      };
      mockAssetService.create.mockResolvedValue(created);
      const app = await createRouteTestFastify({
        plugin: (f) => assetsPlugin(f, { db, storage: mockStorage }),
        principal: actorBoard([company1]),
      });
      const boundary = "----TestBoundary123";
      const body = buildMultipartBody(minimalPng, boundary);
      const res = await app.inject({
        method: "POST",
        url: `/api/companies/${company1}/assets/images`,
        headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
        payload: body,
      });
      expect(res.statusCode).toBe(201);
      expect(res.json()).toMatchObject({ assetId, companyId: company1, contentType: "image/png" });
      expect(mockStorage.putFile).toHaveBeenCalled();
      expect(mockAssetService.create).toHaveBeenCalled();
      expect(mockLogActivity).toHaveBeenCalled();
      await app.close();
    });

    it("returns 403 when agent calls with another company", async () => {
      const app = await createRouteTestFastify({
        plugin: (f) => assetsPlugin(f, { db, storage: mockStorage }),
        principal: actorAgent(company2),
      });
      const boundary = "----TestBoundary123";
      const body = buildMultipartBody(minimalPng, boundary);
      const res = await app.inject({
        method: "POST",
        url: `/api/companies/${company1}/assets/images`,
        headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
        payload: body,
      });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ error: expect.any(String) });
      expect(mockStorage.putFile).not.toHaveBeenCalled();
      await app.close();
    });
  });
});
