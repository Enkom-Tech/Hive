import { PassThrough } from "node:stream";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@hive/db";
import { createRouteTestApp, actorBoard, actorAgent } from "./helpers/route-app.js";
import { assetRoutes } from "../routes/assets.js";
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
      const app = createRouteTestApp({
        router: assetRoutes(db, mockStorage),
        principal: actorBoard([company1]),
      });
      const res = await request(app).get(`/api/assets/${assetId}/content`);
      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({ error: "Asset not found" });
      expect(mockStorage.getObject).not.toHaveBeenCalled();
    });

    it("returns 403 when asset belongs to company actor cannot access", async () => {
      mockAssetService.getById.mockResolvedValue(assetPayload);
      const app = createRouteTestApp({
        router: assetRoutes(db, mockStorage),
        principal: actorBoard([company2]),
      });
      const res = await request(app).get(`/api/assets/${assetId}/content`);
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ error: expect.any(String) });
    });
  });

  describe("POST /api/companies/:companyId/assets/images", () => {
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
      const app = createRouteTestApp({
        router: assetRoutes(db, mockStorage),
        principal: actorBoard([company1]),
      });
      const minimalPng = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
        "base64",
      );
      const res = await request(app)
        .post(`/api/companies/${company1}/assets/images`)
        .attach("file", minimalPng, { filename: "x.png", contentType: "image/png" });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ assetId, companyId: company1, contentType: "image/png" });
      expect(mockStorage.putFile).toHaveBeenCalled();
      expect(mockAssetService.create).toHaveBeenCalled();
      expect(mockLogActivity).toHaveBeenCalled();
    });

    it("returns 403 when agent calls with another company", async () => {
      const app = createRouteTestApp({
        router: assetRoutes(db, mockStorage),
        principal: actorAgent(company2),
      });
      const minimalPng = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
        "base64",
      );
      const res = await request(app)
        .post(`/api/companies/${company1}/assets/images`)
        .attach("file", minimalPng, { filename: "x.png", contentType: "image/png" });
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ error: expect.any(String) });
      expect(mockStorage.putFile).not.toHaveBeenCalled();
    });
  });
});
