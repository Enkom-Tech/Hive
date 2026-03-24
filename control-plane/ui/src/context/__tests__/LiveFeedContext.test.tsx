import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { LiveFeedProvider, useLiveFeed } from "../LiveFeedContext";
import type { LiveEvent } from "@hive/shared";
import { LIVE_FEED_MAX_ITEMS } from "@hive/shared";
import { activityApi } from "../../api/activity";

vi.mock("../../api/activity", () => ({
  activityApi: {
    list: vi.fn(() => Promise.resolve([])),
  },
}));

function wrapper({ children }: { children: React.ReactNode }) {
  return <LiveFeedProvider>{children}</LiveFeedProvider>;
}

function makeEvent(overrides: Partial<LiveEvent> & { id: number; type: string }): LiveEvent {
  const { id, type, payload, createdAt, companyId, ...rest } = overrides;
  return {
    id,
    companyId: companyId ?? "company-1",
    type: type as LiveEvent["type"],
    createdAt: createdAt ?? new Date().toISOString(),
    payload: payload ?? {},
    ...rest,
  };
}

const CLEARED_KEY = "hive:live-feed-cleared-at:company-1";

describe("LiveFeedContext", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.removeItem(CLEARED_KEY);
  });

  afterEach(() => {
    localStorage.removeItem(CLEARED_KEY);
  });

  it("append adds activity event to items", () => {
    const { result } = renderHook(() => useLiveFeed(), { wrapper });
    expect(result.current.items).toHaveLength(0);

    act(() => {
      result.current.append(
        makeEvent({
          id: 1,
          type: "activity.logged",
          payload: { action: "issue.created", entityType: "issue", entityId: "issue-1" },
        }),
        "live",
      );
    });
    expect(result.current.items).toHaveLength(1);
    expect(result.current.items[0]!.kind).toBe("activity");
    expect(result.current.items[0]!.event.type).toBe("activity.logged");
  });

  it("append does not add duplicate event (idempotency)", () => {
    const { result } = renderHook(() => useLiveFeed(), { wrapper });
    const ev = makeEvent({
      id: 42,
      type: "activity.logged",
      payload: { action: "issue.updated", entityType: "issue", entityId: "issue-1" },
    });

    act(() => {
      result.current.append(ev, "live");
    });
    act(() => {
      result.current.append(ev, "live");
    });
    expect(result.current.items).toHaveLength(1);
  });

  it("append does not add heartbeat.run.log (excluded)", () => {
    const { result } = renderHook(() => useLiveFeed(), { wrapper });
    act(() => {
      result.current.append(
        makeEvent({ id: 2, type: "heartbeat.run.log", payload: {} }),
        "live",
      );
    });
    expect(result.current.items).toHaveLength(0);
  });

  it("append adds terminal heartbeat.run.status", () => {
    const { result } = renderHook(() => useLiveFeed(), { wrapper });
    act(() => {
      result.current.append(
        makeEvent({
          id: 3,
          type: "heartbeat.run.status",
          payload: { runId: "r1", agentId: "a1", status: "succeeded" },
        }),
        "live",
      );
    });
    expect(result.current.items).toHaveLength(1);
    expect(result.current.items[0]!.kind).toBe("run_status");
  });

  it("clear empties items", () => {
    const { result } = renderHook(() => useLiveFeed(), { wrapper });
    act(() => {
      result.current.append(
        makeEvent({ id: 1, type: "activity.logged", payload: {} }),
        "live",
      );
    });
    expect(result.current.items).toHaveLength(1);
    act(() => {
      result.current.clear("company-1");
    });
    expect(result.current.items).toHaveLength(0);
    expect(localStorage.getItem(CLEARED_KEY)).toBeTruthy();
  });

  it("hydrate omits activity at or before persisted clear cutoff", async () => {
    const cutoff = new Date("2025-06-01T12:00:00.000Z");
    localStorage.setItem(CLEARED_KEY, cutoff.toISOString());
    vi.mocked(activityApi.list).mockResolvedValueOnce([
      {
        id: "act-old",
        companyId: "company-1",
        actorType: "user",
        actorId: "u1",
        action: "issue.created",
        entityType: "issue",
        entityId: "i1",
        agentId: null,
        runId: null,
        details: null,
        createdAt: new Date("2025-06-01T11:00:00.000Z"),
      },
      {
        id: "act-new",
        companyId: "company-1",
        actorType: "user",
        actorId: "u1",
        action: "issue.updated",
        entityType: "issue",
        entityId: "i2",
        agentId: null,
        runId: null,
        details: null,
        createdAt: new Date("2025-06-01T14:00:00.000Z"),
      },
    ]);

    const { result } = renderHook(() => useLiveFeed(), { wrapper });
    await act(async () => {
      await result.current.hydrate("company-1");
    });

    expect(result.current.items).toHaveLength(1);
    expect(result.current.items[0]!.event.payload).toMatchObject({ id: "act-new" });
  });

  it("getFilteredItems filters by activity when filter is activity", () => {
    const { result } = renderHook(() => useLiveFeed(), { wrapper });
    act(() => {
      result.current.setFilter("activity");
      result.current.append(
        makeEvent({ id: 1, type: "activity.logged", payload: {} }),
        "live",
      );
      result.current.append(
        makeEvent({
          id: 2,
          type: "heartbeat.run.status",
          payload: { runId: "r1", agentId: "a1", status: "succeeded" },
        }),
        "live",
      );
    });
    const filtered = result.current.getFilteredItems();
    expect(filtered).toHaveLength(1);
    expect(filtered[0]!.kind).toBe("activity");
  });

  it("caps items at LIVE_FEED_MAX_ITEMS", () => {
    const { result } = renderHook(() => useLiveFeed(), { wrapper });
    act(() => {
      for (let i = 0; i < LIVE_FEED_MAX_ITEMS + 10; i++) {
        result.current.append(
          makeEvent({
            id: i + 1,
            type: "activity.logged",
            payload: {},
            createdAt: new Date(Date.now() - i * 1000).toISOString(),
          }),
          "live",
        );
      }
    });
    expect(result.current.items).toHaveLength(LIVE_FEED_MAX_ITEMS);
  });
});
