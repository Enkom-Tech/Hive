import { test, expect } from "@playwright/test";

/**
 * Smoke: worker download metadata API (used by Workers page and install scripts).
 * Does not require a logged-in session; matches public GET /api/worker-downloads/ behavior in local_trusted.
 */
test.describe("Worker downloads API", () => {
  test("returns JSON with tag, artifacts, and optional workerDeliveryBusConfigured", async ({ request }) => {
    const res = await request.get("/api/worker-downloads/");
    expect(res.ok()).toBeTruthy();
    const body = (await res.json()) as {
      tag: string;
      artifacts: unknown[];
      workerDeliveryBusConfigured?: boolean;
    };
    expect(typeof body.tag).toBe("string");
    expect(Array.isArray(body.artifacts)).toBe(true);
    if ("workerDeliveryBusConfigured" in body) {
      expect(typeof body.workerDeliveryBusConfigured).toBe("boolean");
    }
  });
});
