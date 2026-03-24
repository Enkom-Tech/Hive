import { describe, expect, it } from "vitest";
import { validateManagedWorkerConfig } from "../adapters/managed-worker/validate.js";

describe("managed-worker validateConfig", () => {
  it("accepts empty config (only timeoutMs validated when present)", () => {
    expect(() => validateManagedWorkerConfig({}, undefined)).not.toThrow();
  });

  it("accepts timeoutMs in range", () => {
    expect(() =>
      validateManagedWorkerConfig({ timeoutMs: 15000 }, undefined),
    ).not.toThrow();
    expect(() =>
      validateManagedWorkerConfig({ timeoutMs: 1000 }, undefined),
    ).not.toThrow();
    expect(() =>
      validateManagedWorkerConfig({ timeoutMs: 300000 }, undefined),
    ).not.toThrow();
  });

  it("rejects timeoutMs out of range", () => {
    expect(() =>
      validateManagedWorkerConfig({ timeoutMs: 0 }, undefined),
    ).toThrow(/1000 and 300000/);
    expect(() =>
      validateManagedWorkerConfig({ timeoutMs: 500 }, undefined),
    ).toThrow(/1000 and 300000/);
    expect(() =>
      validateManagedWorkerConfig({ timeoutMs: 400000 }, undefined),
    ).toThrow(/1000 and 300000/);
  });
});
