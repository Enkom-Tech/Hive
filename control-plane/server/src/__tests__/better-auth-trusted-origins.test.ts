import { describe, expect, it } from "vitest";
import { deriveAuthTrustedOrigins } from "../auth/better-auth.js";
import type { Config } from "../config.js";

function authOriginsConfig(
  partial: Pick<Config, "deploymentMode" | "allowedHostnames" | "port" | "authBaseUrlMode" | "authPublicBaseUrl">,
): Config {
  return partial as unknown as Config;
}

describe("deriveAuthTrustedOrigins", () => {
  it("adds loopback origins when authenticated with empty allowedHostnames and no public auth URL", () => {
    const origins = deriveAuthTrustedOrigins(
      authOriginsConfig({
        deploymentMode: "authenticated",
        allowedHostnames: [],
        port: 3100,
        authBaseUrlMode: "auto",
        authPublicBaseUrl: undefined,
      }),
    );
    expect(origins).toContain("http://127.0.0.1:3100");
    expect(origins).toContain("http://localhost:3100");
  });

  it("skips loopback fallback when authPublicBaseUrl is set", () => {
    const origins = deriveAuthTrustedOrigins(
      authOriginsConfig({
        deploymentMode: "authenticated",
        allowedHostnames: [],
        port: 3100,
        authBaseUrlMode: "explicit",
        authPublicBaseUrl: "https://board.example.com",
      }),
    );
    expect(origins).toContain("https://board.example.com");
    expect(origins).not.toContain("http://127.0.0.1:3100");
    expect(origins).not.toContain("http://localhost:3100");
  });

  it("uses allowedHostnames when provided instead of only loopback fallback", () => {
    const origins = deriveAuthTrustedOrigins(
      authOriginsConfig({
        deploymentMode: "authenticated",
        allowedHostnames: ["board.internal"],
        port: 3100,
        authBaseUrlMode: "auto",
        authPublicBaseUrl: undefined,
      }),
    );
    expect(origins).toContain("http://board.internal");
    expect(origins).toContain("https://board.internal");
    expect(origins).not.toContain("http://localhost:3100");
  });
});
