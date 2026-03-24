import { describe, it, expect } from "vitest";
import {
  applyCompanyPrefix,
  extractCompanyPrefixFromPath,
  isBoardPathWithoutPrefix,
  isGlobalPath,
  normalizeCompanyPrefix,
  toCompanyRelativePath,
} from "../company-routes";

/**
 * First path segment of each top-level route in App.tsx boardRoutes().
 * When adding a new board route, add it here and to BOARD_ROUTE_ROOTS in company-routes.ts.
 */
const EXPECTED_BOARD_ROUTE_ROOTS = [
  "dashboard",
  "companies",
  "company",
  "org",
  "agents",
  "projects",
  "issues",
  "goals",
  "approvals",
  "costs",
  "standup",
  "activity",
  "inbox",
  "design-guide",
];

describe("company-routes", () => {
  describe("normalizeCompanyPrefix", () => {
    it("uppercases and trims prefix", () => {
      expect(normalizeCompanyPrefix("abc")).toBe("ABC");
      expect(normalizeCompanyPrefix("  xYz  ")).toBe("XYZ");
    });
  });

  describe("isGlobalPath", () => {
    it("returns true for / and global roots", () => {
      expect(isGlobalPath("/")).toBe(true);
      expect(isGlobalPath("/auth")).toBe(true);
      expect(isGlobalPath("/invite/foo")).toBe(true);
      expect(isGlobalPath("/board-claim/bar")).toBe(true);
    });

    it("returns false for board and company-prefixed paths", () => {
      expect(isGlobalPath("/dashboard")).toBe(false);
      expect(isGlobalPath("/ABC/dashboard")).toBe(false);
    });
  });

  describe("isBoardPathWithoutPrefix", () => {
    it("returns true for all expected board route roots", () => {
      for (const root of EXPECTED_BOARD_ROUTE_ROOTS) {
        expect(isBoardPathWithoutPrefix(`/${root}`)).toBe(true);
        expect(isBoardPathWithoutPrefix(`/${root}/nested`)).toBe(true);
      }
    });

    it("returns true for standup (regression: standup must be a board route)", () => {
      expect(isBoardPathWithoutPrefix("/standup")).toBe(true);
      expect(isBoardPathWithoutPrefix("/standup/")).toBe(true);
    });

    it("returns false for unknown first segment (company prefix)", () => {
      expect(isBoardPathWithoutPrefix("/ABC")).toBe(false);
      expect(isBoardPathWithoutPrefix("/ABC/dashboard")).toBe(false);
    });

    it("returns false for empty or non-path", () => {
      expect(isBoardPathWithoutPrefix("")).toBe(false);
    });
  });

  describe("extractCompanyPrefixFromPath", () => {
    it("returns null for board route roots (so they are not treated as company prefix)", () => {
      for (const root of EXPECTED_BOARD_ROUTE_ROOTS) {
        expect(extractCompanyPrefixFromPath(`/${root}`)).toBe(null);
      }
    });

    it("returns null for standup (regression: /standup must not be parsed as company prefix)", () => {
      expect(extractCompanyPrefixFromPath("/standup")).toBe(null);
      expect(extractCompanyPrefixFromPath("/standup/")).toBe(null);
    });

    it("returns normalized prefix when first segment is not global or board", () => {
      expect(extractCompanyPrefixFromPath("/ABC")).toBe("ABC");
      expect(extractCompanyPrefixFromPath("/abc/dashboard")).toBe("ABC");
    });

    it("returns null for global paths", () => {
      expect(extractCompanyPrefixFromPath("/auth")).toBe(null);
    });
  });

  describe("applyCompanyPrefix", () => {
    it("prefixes board paths when company prefix is provided", () => {
      expect(applyCompanyPrefix("/dashboard", "ABC")).toBe("/ABC/dashboard");
      expect(applyCompanyPrefix("/standup", "xyz")).toBe("/XYZ/standup");
    });

    it("produces /ABC/standup for standup (regression: sidebar Standup link)", () => {
      expect(applyCompanyPrefix("/standup", "ABC")).toBe("/ABC/standup");
      expect(applyCompanyPrefix("/standup", "c-123")).toBe("/C-123/standup");
    });

    it("leaves path unchanged when path already has company prefix", () => {
      expect(applyCompanyPrefix("/ABC/dashboard", "ABC")).toBe("/ABC/dashboard");
    });

    it("leaves path unchanged when company prefix is null/undefined", () => {
      expect(applyCompanyPrefix("/standup", null)).toBe("/standup");
      expect(applyCompanyPrefix("/standup", undefined)).toBe("/standup");
    });

    it("preserves search and hash", () => {
      expect(applyCompanyPrefix("/standup?foo=1#bar", "ABC")).toBe("/ABC/standup?foo=1#bar");
    });

    it("does not prefix global paths", () => {
      expect(applyCompanyPrefix("/auth", "ABC")).toBe("/auth");
    });
  });

  describe("toCompanyRelativePath", () => {
    it("strips company prefix when second segment is board route", () => {
      expect(toCompanyRelativePath("/ABC/standup")).toBe("/standup");
      expect(toCompanyRelativePath("/ABC/dashboard")).toBe("/dashboard");
    });

    it("leaves path unchanged when no company prefix", () => {
      expect(toCompanyRelativePath("/standup")).toBe("/standup");
    });
  });
});
