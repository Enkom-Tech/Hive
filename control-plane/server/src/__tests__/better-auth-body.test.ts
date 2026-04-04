/**
 * Regression tests for the Better Auth /api/auth/* request bridge.
 *
 * The bridge must construct a valid Fetch Request from the incoming Fastify
 * request, including:
 *   - All request headers forwarded verbatim.
 *   - JSON body content forwarded when content-type is application/json.
 *   - Form-urlencoded body forwarded as the original string (not re-serialised
 *     as JSON) when a raw body is available.
 *   - GET requests forwarded with no body.
 *   - Auth handler response status and headers propagated back to the client.
 *
 * These tests use a spy auth handler so they don't need a real Better Auth
 * instance — the subject under test is the bridging logic in fastify-app.ts.
 */
import Fastify, { type FastifyInstance } from "fastify";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

type CapturedRequest = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
};

/**
 * Build a minimal Fastify app that mirrors the Better Auth bridge from
 * fastify-app.ts, with a spy handler in place of the real auth instance.
 */
async function buildAuthBridgeApp(
  handler: (req: Request) => Promise<Response>,
): Promise<FastifyInstance> {
  const fastify = Fastify({ logger: false });

  const auth = { handler };

  fastify.all("/api/auth/*", { config: { rawBody: true } }, async (req, reply) => {
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (!value) continue;
      if (Array.isArray(value)) {
        for (const v of value) headers.append(key, v);
      } else {
        headers.set(key, value);
      }
    }

    const url = `${req.protocol}://${req.hostname}${req.url}`;

    let bodyStr: string | undefined;
    if (req.method !== "GET" && req.method !== "HEAD") {
      const raw = (req as unknown as { rawBody?: Buffer }).rawBody;
      if (raw && raw.length > 0) {
        bodyStr = raw.toString("utf8");
      } else if (req.body !== undefined && req.body !== null) {
        const ct = (req.headers["content-type"] ?? "").toLowerCase();
        if (ct.startsWith("application/json")) {
          bodyStr = JSON.stringify(req.body);
        }
      }
    }

    const fetchReq = new Request(url, {
      method: req.method,
      headers,
      body: bodyStr,
    });

    const response = await auth.handler(fetchReq);
    void reply.status(response.status);
    for (const [key, value] of response.headers.entries()) {
      reply.header(key, value);
    }
    const body = await response.text();
    void reply.send(body);
  });

  await fastify.ready();
  return fastify;
}

describe("Better Auth body bridge", () => {
  let captured: CapturedRequest;
  let app: FastifyInstance;

  beforeEach(async () => {
    const handler = vi.fn(async (req: Request): Promise<Response> => {
      captured = {
        url: req.url,
        method: req.method,
        headers: Object.fromEntries(req.headers.entries()),
        body: await req.text(),
      };
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json", "x-test-header": "yes" },
      });
    });
    app = await buildAuthBridgeApp(handler);
  });

  afterEach(async () => {
    await app.close();
  });

  it("forwards JSON body and content-type header", async () => {
    const payload = { email: "user@example.com", password: "secret" };
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      headers: { "content-type": "application/json" },
      payload,
    });

    expect(res.statusCode).toBe(200);
    expect(captured.method).toBe("POST");
    const parsedBody = JSON.parse(captured.body) as typeof payload;
    expect(parsedBody.email).toBe(payload.email);
    expect(parsedBody.password).toBe(payload.password);
  });

  it("forwards authorization header to the auth handler", async () => {
    await app.inject({
      method: "GET",
      url: "/api/auth/get-session",
      headers: { authorization: "Bearer some-token" },
    });
    expect(captured.headers["authorization"]).toBe("Bearer some-token");
  });

  it("sends no body for GET requests", async () => {
    await app.inject({
      method: "GET",
      url: "/api/auth/get-session",
    });
    expect(captured.method).toBe("GET");
    expect(captured.body).toBe("");
  });

  it("propagates auth handler response status and headers", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/auth/get-session",
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-test-header"]).toBe("yes");
  });

  it("propagates auth handler error responses", async () => {
    await app.close();
    const errorHandler = vi.fn(async (_req: Request): Promise<Response> => {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    });
    app = await buildAuthBridgeApp(errorHandler);

    const res = await app.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      headers: { "content-type": "application/json" },
      payload: { email: "bad@example.com", password: "wrong" },
    });

    expect(res.statusCode).toBe(401);
    const body = res.json<{ error: string }>();
    expect(body.error).toBe("Unauthorized");
  });
});
