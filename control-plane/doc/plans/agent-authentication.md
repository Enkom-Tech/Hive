# Agent Authentication & Onboarding

## Target model: worker credentials

In the target architecture **agents do not authenticate with the control plane**. The **worker** (drone) holds credentials and calls the control plane on behalf of agents. Agents run under the worker and access control-plane actions only via tools/MCP exposed by the worker. Communication between worker and control plane is **WebSocket-only** (worker connects outbound); see [DRONE-SPEC.md](../DRONE-SPEC.md). See [MANAGED-WORKER-ARCHITECTURE.md](../MANAGED-WORKER-ARCHITECTURE.md) and [SPEC-implementation.md](../SPEC-implementation.md) for the full picture.

The previous P0 plan (local adapter JWT for `claude_local` / `codex_local`) is superseded by the managed-worker model. Implementation work should focus on worker credentials and drone-side behavior.

---

## Part I — Product / model

### Worker credential model

1. **Registration / binding:** The worker is registered with the control plane (e.g. via one-liner install with token, or a dedicated registration/claim flow). Credentials are bound to the worker, not to individual agents.
2. **Invite and claim:** When onboarding a new machine or worker, an admin (or authorized agent) can generate an **invite**. The worker (or operator) uses that invite to claim credentials. No API key is given to the agent process.
3. **Approval gates:** Worker registration and invite-claim can require explicit approval (human or delegated to a manager-level agent with appropriate permission, e.g. `joins:approve`). Approval sets reporting chain, role, and budget where applicable.
4. **Revocation:** Admins can revoke or regenerate worker credentials. Agents under that worker lose access until credentials are restored.

### What agents do not do

- Agents do not hold or see API keys.
- Agents do not call the control plane directly.
- Agents do not "self-register" with the control plane; the worker is registered, and the worker spawns agents with identity/permissions set per run.

### Implementation priorities

- Worker registration and credential storage (see SPEC-implementation: worker credentials, heartbeat).
- Invite/claim flow for worker registration (link or token → pending approval → approve → credentials bound to worker).
- Approval flow for new workers (re-use or extend human/agent join-request approval with worker-specific metadata; see [humans-and-permissions.md](humans-and-permissions.md)).
- Documentation: operator-facing docs should describe worker setup and credential binding, not per-agent API key setup.

### Open questions

- Invite link expiry: single-use or multi-use? Time-limited?
- Credential renewal: how to rotate worker credentials without downtime?
- Delegated approval: which permissions allow approving worker registrations?

---

## Part II — Implementation contract

### Worker credential implementation tasks

1. **Worker registration and credential storage:** Control plane supports registering a worker (e.g. by token or claim endpoint). Store worker credentials (e.g. hashed API key or token) and associate with company/agent context. Align with SPEC-implementation schema for worker credentials and heartbeat.
2. **Invite/claim flow for workers:** Invite link or token that allows a worker (or operator) to complete registration. Pending state until approval; on approval, bind credentials to the worker. Re-use or extend join-request/approval flow where applicable.
3. **Drone env and auth:** Document and implement how the drone receives and uses its credential (env var, file, one-liner install token). Drone uses credential to connect to the control plane via WebSocket and for all messages (heartbeat, run status, log stream, tools/MCP). Transport is WebSocket-only; see DRONE-SPEC.md for env vars and configuration.

---

## See also

- [MANAGED-WORKER-ARCHITECTURE.md](../MANAGED-WORKER-ARCHITECTURE.md)
- [DRONE-SPEC.md](../DRONE-SPEC.md)
- [SPEC-implementation.md](../SPEC-implementation.md) (worker credentials, heartbeat, run request)
- [humans-and-permissions.md](humans-and-permissions.md) (invite/join/approval model)
- [K3S-LLM-DEPLOYMENT.md](../K3S-LLM-DEPLOYMENT.md) (production k3s: control plane, workers, vLLM, model gateway)
