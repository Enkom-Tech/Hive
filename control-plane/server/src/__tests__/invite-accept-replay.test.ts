import { describe, expect, it } from "vitest";
import {
  buildJoinDefaultsPayloadForAccept,
  mergeJoinDefaultsPayloadForReplay,
} from "../routes/access.js";

describe("mergeJoinDefaultsPayloadForReplay", () => {
  it("merges replay payloads and buildJoinDefaultsPayloadForAccept returns payload as-is", () => {
    const merged = mergeJoinDefaultsPayloadForReplay(
      {
        hiveApiUrl: "http://host.docker.internal:3100",
        headers: { "x-custom": "keep-me" },
      },
      {
        hiveApiUrl: "https://hive.example.com",
        headers: { "authorization": "Bearer new-token" },
      },
    );

    const result = buildJoinDefaultsPayloadForAccept({
      adapterType: "managed_worker",
      defaultsPayload: merged,
    }) as Record<string, unknown>;

    expect(result).toBe(merged);
    expect(result.hiveApiUrl).toBe("https://hive.example.com");
    expect(result.headers).toMatchObject({
      "x-custom": "keep-me",
      "authorization": "Bearer new-token",
    });
  });
});
