import { describe, expect, it } from "vitest";
import { executionWorkspaceCleanupShouldRun } from "../services/workspace-runtime.js";

describe("executionWorkspaceCleanupShouldRun", () => {
  it("manual never runs", () => {
    expect(executionWorkspaceCleanupShouldRun("manual", "done")).toBe(false);
    expect(executionWorkspaceCleanupShouldRun("", "done")).toBe(false);
  });

  it("on_done runs for done and cancelled", () => {
    expect(executionWorkspaceCleanupShouldRun("on_done", "done")).toBe(true);
    expect(executionWorkspaceCleanupShouldRun("on_done", "cancelled")).toBe(true);
    expect(executionWorkspaceCleanupShouldRun("on_done", "in_progress")).toBe(false);
  });

  it("on_merged runs only for done", () => {
    expect(executionWorkspaceCleanupShouldRun("on_merged", "done")).toBe(true);
    expect(executionWorkspaceCleanupShouldRun("on_merged", "cancelled")).toBe(false);
    expect(executionWorkspaceCleanupShouldRun("on_merged", "in_progress")).toBe(false);
  });

  it("unknown mode is false", () => {
    expect(executionWorkspaceCleanupShouldRun("on_foo", "done")).toBe(false);
  });
});
