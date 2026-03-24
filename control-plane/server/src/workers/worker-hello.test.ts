import { describe, expect, it } from "vitest";
import { parseDroneFromAgentMetadata, parseWorkerHelloMessage } from "./worker-hello.js";

describe("parseWorkerHelloMessage", () => {
  it("returns null when type is not hello", () => {
    expect(parseWorkerHelloMessage({ type: "status" })).toBeNull();
  });

  it("parses hello fields", () => {
    const p = parseWorkerHelloMessage({
      type: "hello",
      hostname: " box ",
      os: "linux",
      arch: "arm64",
      version: "1.2.3",
      instanceId: "550e8400-e29b-41d4-a716-446655440000",
    });
    expect(p).toEqual({
      hostname: "box",
      os: "linux",
      arch: "arm64",
      version: "1.2.3",
      instanceId: "550e8400-e29b-41d4-a716-446655440000",
    });
  });
});

describe("parseDroneFromAgentMetadata", () => {
  it("returns null when drone missing", () => {
    expect(parseDroneFromAgentMetadata({})).toBeNull();
  });

  it("reads drone object", () => {
    expect(
      parseDroneFromAgentMetadata({
        drone: {
          hostname: "h",
          lastHelloAt: "2025-01-01T00:00:00.000Z",
        },
      }),
    ).toEqual({
      hostname: "h",
      os: null,
      arch: null,
      version: null,
      instanceId: null,
      lastHelloAt: "2025-01-01T00:00:00.000Z",
    });
  });
});
