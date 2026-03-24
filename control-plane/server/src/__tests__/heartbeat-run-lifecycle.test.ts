import { describe, expect, it, vi } from "vitest";
import type { Db } from "@hive/db";
import { createRunLifecycle } from "../services/heartbeat/run-lifecycle.js";

const noop = () => {};

describe("createRunLifecycle", () => {
  it("returns getRun, setRunStatus, claimQueuedRun, and other lifecycle methods", () => {
    const db = {} as Db;
    const runLogStore = {
      read: vi.fn().mockResolvedValue({ content: "", nextOffset: undefined }),
      append: vi.fn().mockResolvedValue(undefined),
      finalize: vi.fn().mockResolvedValue({ bytes: 0, compressed: false }),
    };
    const lifecycle = createRunLifecycle({
      db,
      runLogStore,
      publishLiveEvent: noop,
      getSessionCodec: () => ({ encode: (x) => x, decode: (x) => x }),
    });

    expect(lifecycle).toHaveProperty("getRun");
    expect(lifecycle).toHaveProperty("setRunStatus");
    expect(lifecycle).toHaveProperty("setWakeupStatus");
    expect(lifecycle).toHaveProperty("claimQueuedRun");
    expect(lifecycle).toHaveProperty("touchRun");
    expect(lifecycle).toHaveProperty("list");
    expect(lifecycle).toHaveProperty("enqueueWakeup");
    expect(lifecycle).toHaveProperty("cancelRun");
    expect(typeof lifecycle.getRun).toBe("function");
    expect(typeof lifecycle.setRunStatus).toBe("function");
  });
});
