import { describe, expect, it } from "vitest";
import {
  redactEnvValue,
  shouldRedactSecretValue,
} from "./env-redaction.js";

const id = <T>(x: T) => x;
const idVal = (x: unknown) => x;

describe("env-redaction", () => {
  it("flags secret-like keys", () => {
    expect(shouldRedactSecretValue("api_key", "x")).toBe(true);
    expect(shouldRedactSecretValue("FOO", "x")).toBe(false);
  });

  it("redacts JWT-shaped strings", () => {
    expect(
      shouldRedactSecretValue("token", "a.b.c"),
    ).toBe(true);
  });

  it("redacts via redactEnvValue with path redactors", () => {
    expect(
      redactEnvValue("api_key", "secret", id, idVal),
    ).toBe("***REDACTED***");
    expect(redactEnvValue("x", null, id, idVal)).toBe("");
    expect(redactEnvValue("x", { type: "secret_ref" }, id, idVal)).toBe(
      "***SECRET_REF***",
    );
  });
});
