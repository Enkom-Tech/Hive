import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  hiveInstanceRelativePathIfUnderRoot,
  resolveHiveInstanceRoot,
} from "../home-paths.js";

describe("hiveInstanceRelativePathIfUnderRoot", () => {
  it("returns forward-slash path under instance root", () => {
    const root = resolveHiveInstanceRoot();
    const child = path.join(root, "workspaces", "agent-1");
    expect(hiveInstanceRelativePathIfUnderRoot(child)).toBe("workspaces/agent-1");
  });

  it("returns null for paths outside instance root", () => {
    expect(hiveInstanceRelativePathIfUnderRoot("/tmp/outside")).toBeNull();
  });

  it("returns dot for instance root itself", () => {
    const root = resolveHiveInstanceRoot();
    expect(hiveInstanceRelativePathIfUnderRoot(root)).toBe(".");
  });
});
