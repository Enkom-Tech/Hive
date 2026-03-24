# Webhooks and external agent lifecycle

In the managed-worker architecture, work-available is signaled to the worker via the worker's WebSocket link to the control plane (e.g. run or work-available message), not to per-agent webhooks. The following describes the per-agent webhook contract for legacy or compatibility use only.

## Webhook configuration

Per-agent webhook settings live in `runtimeConfig`:

- **webhookUrl** (string, optional): URL to POST when there is work for this agent. In production must be HTTPS.
- **webhookSecret** (string, optional): Secret used to sign the request body (HMAC-SHA256). Required when webhookUrl is set. Never logged or returned in API responses.

Configure these in the agent’s runtime config (e.g. via PATCH agent or UI). If only `webhookUrl` is set and `webhookSecret` is missing, no webhook is sent.

## When webhooks are sent

When an issue is created or updated and the resulting issue has an agent assignee and a workable status (`todo` or `in_progress`), Hive POSTs a `work_available` event to that agent’s `webhookUrl` (if set and valid). Delivery is best-effort and fire-and-forget; the API response is not blocked. Duplicate deliveries are possible; receivers should treat the event as “reconsider work” (e.g. poll once or run one work cycle).

## Delivery behavior

- **Retries:** Delivery is retried only on 5xx, 408 (Request Timeout), 429 (Too Many Requests), and on network/timeout errors. Other 4xx responses are not retried. Backoff between attempts is configurable with jitter to avoid thundering herd.
- **Circuit breaker:** Per-agent in-memory state tracks consecutive failures. After a threshold of failures within a time window, delivery is skipped (circuit open) until a cooldown elapses, then one probe attempt is allowed (half-open); success closes the circuit, failure reopens it.
- **Idempotency and verification:** Receivers must treat events as idempotent and must verify the request using a **timing-safe** comparison of the signature (see [Signature verification](#signature-verification)).

## Event type: work_available

**Payload (JSON body):**

```json
{
  "event": "work_available",
  "issueId": "<uuid>",
  "companyId": "<uuid>",
  "agentId": "<uuid>",
  "timestamp": "<ISO8601>",
  "version": 1
}
```

**Headers:**

- `Content-Type: application/json`
- `X-Hive-Signature`: HMAC-SHA256 of the raw request body (UTF-8), hex-encoded, using `webhookSecret`.
- `X-Hive-Webhook-Version`: `1`

## Signature verification

Algorithm: HMAC-SHA256 of the **raw request body** (as received, UTF-8), keyed by `webhookSecret`; output is hex-encoded.

Receivers **must** use a **constant-time** comparison (e.g. `crypto.timingSafeEqual`) so that signature length or content does not leak via timing. Compare only when both buffers have the same length; otherwise return false without comparing.

Node.js example (constant-time, length-checked):

```js
const crypto = require("node:crypto");

function verifyWebhookSignature(rawBody, signatureHeader, secret) {
  const expected = crypto.createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
  const a = Buffer.from(signatureHeader, "hex");
  const b = Buffer.from(expected, "hex");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
```

Use the raw body (e.g. `req.body` as a string or buffer before JSON parsing) so the signature matches what Hive computed. Reject the request if the signature does not match.

## External agent lifecycle

External agents (e.g. Akira in Mission Control) do not run inside Hive’s process. Their runs are still represented in `heartbeat_runs` and are distinguished by `triggerDetail === 'external_agent_checkout'`.

1. **Get work**  
   Poll the issues API and/or receive `work_available` webhooks when an issue is assigned to the agent and in a workable status (`todo`, `in_progress`).

2. **Check out**  
   POST to the checkout endpoint with header `X-Hive-Run-Id: <your-run-uuid>`. Hive creates a `heartbeat_runs` row if it does not exist (with `triggerDetail: external_agent_checkout`) and links the issue to that run.

3. **Keep run alive (optional)**  
   While working, call `PATCH /api/heartbeat-runs/:runId` with the same run id (agent auth required). This updates only `updated_at` and returns 204. Use it periodically (e.g. every 30s) so future timeout-based reaping (if added) does not mark the run as lost.

4. **Close the issue**  
   PATCH the issue to `done` or `cancelled`. Hive sets the linked run to `succeeded` or `cancelled`, sets `finishedAt`, and clears the issue’s execution fields. The external agent does not call a separate “finish run” API.

5. **Reaper**  
   Runs with `triggerDetail === 'external_agent_checkout'` are not reaped as `process_lost`; they are only finished when the issue is closed (or explicitly cancelled).
