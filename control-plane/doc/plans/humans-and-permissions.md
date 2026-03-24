# Humans and Permissions

Status: In progress
Date: 2026-02-21
Owners: Server + UI + CLI + DB + Shared

Canonical mode names are `local_trusted` and `authenticated` (see [DEPLOYMENT-MODES.md](../DEPLOYMENT-MODES.md)). Human auth provider is configurable: `builtin` (Better Auth, default) or `logto` (optional; switch to Logto for SSO/enterprise when implemented). Principal shape and membership/permission semantics are provider-agnostic.

---

## Part I — Product plan

### Goal

Add first-class human users and permissions while preserving two deployment modes:

- local trusted single-user mode with no login friction
- authenticated multi-user mode with mandatory authentication and authorization

### Why this plan

Current assumptions are centered on one board operator. We now need:

- multi-human collaboration with per-user permissions
- safe cloud deployment defaults (no accidental loginless production)
- local mode that still feels instant (`pnpm hive run` and go)
- agent-to-human task delegation, including a human inbox
- one user account with access to multiple companies in one deployment
- instance admins who can manage company access across the instance
- join approvals surfaced as actionable inbox alerts, not buried in admin-only pages
- a symmetric invite-and-approve onboarding path for both humans and agents
- one shared membership and permission model for both humans and agents

### Product constraints

1. Keep company scoping strict for every new table, endpoint, and permission check.
2. Preserve existing control-plane invariants: single-assignee task model, approval gates, budget hard-stop behavior, mutation activity logging.
3. Keep local mode easy and trusted, but prevent unsafe cloud posture.

### Deployment modes

**Mode A: `local_trusted`** — No login UI; browser opens into board context; embedded DB and local storage defaults; local implicit actor has `instance_admin`; full invite/approval/permission flows available. Guardrails: server binds to loopback by default; fail startup if non-loopback; UI shows "Local trusted mode" badge.

**Mode B: `authenticated`** — Login required for all human endpoints; hosted DB and remote deployment; multi-user sessions and role/permission enforcement. Guardrails: fail startup if auth provider/session config is missing; health payload includes mode and auth readiness.

### Authentication choice

- Human auth provider is selectable: **`builtin`** (Better Auth, email/password; default) or **`logto`** (optional; for SSO/enterprise when implemented). Config: `server.authProvider` / `AUTH_PROVIDER`; see `packages/shared/src/constants.ts` (`AUTH_PROVIDERS`).
- Start with email/password for builtin; no email verification requirement.
- Keep implementation structured so switching provider (e.g. Better Auth ↔ Logto) does not change membership/permission semantics; principal type remains `user` | `agent` | `system`.

### Auth and actor model

Unify request actors: `user` (authenticated human), `agent` (API key), `local_board_implicit` (local trusted only). In `authenticated`, only `user` and `agent` are valid; in `local_trusted`, unauthenticated requests resolve to `local_board_implicit` (instance admin). All mutations write `activity_log` with actor type/id.

### First admin bootstrap

New authenticated deployments need a safe first human admin. If no `instance_admin` exists, instance is `bootstrap_pending`. CLI `pnpm hive auth bootstrap-ceo` creates a one-time CEO invite URL; `pnpm hive onboard` prints it when bootstrap pending. Visiting the app while pending shows a blocking setup page with the CLI command. Accepting the CEO invite creates the first admin and exits bootstrap. Rules: bootstrap invite single-use, short-lived, token-hash at rest; one active bootstrap invite at a time; bootstrap actions in `activity_log`. For migration from local_trusted (board-claim flow), see [DEPLOYMENT-MODES.md](../DEPLOYMENT-MODES.md).

### Data model additions (overview)

New tables: identity/users (Better Auth or provider-specific), `instance_user_roles`, `company_memberships`, `principal_permission_grants`, `invites`, `join_requests`. Issues: add `assignee_user_id`; single-assignee invariant (at most one of assignee_agent_id / assignee_user_id). Compatibility: existing `created_by_user_id` / `author_user_id` remain; worker credentials and membership+grants stay the authorization source.

### Permission model

Humans and agents use the same membership + grant engine; checks resolve on `(company_id, principal_type, principal_id)`. Role layers: `instance_admin` (deployment-wide), company-scoped grants. Core grants: `agents:create`, `users:invite`, `users:manage_permissions`, `tasks:assign`, `tasks:assign_scope`, `joins:approve`. Instance admins can promote/demote and manage company access; assignment checks apply to both agent and human assignees.

### Chain-of-command scope

Assignment scope as allow rule over org hierarchy (e.g. `subtree:<agentId>`, `exclude:<agentId>`). Resolve target assignee position and evaluate before assignment; return 403 for out-of-scope.

### Invite and signup flow

Authorized user creates `company_join` invite (optional defaults + expiry). Invite landing: "Join as human" or "Join as agent" (per `allowed_join_types`). Submission consumes token and creates `pending_approval` join request (no access yet). Review metadata: human email, source IP, agent metadata. Admin approves or rejects; on approval: human gets membership+grants, agent gets record and API-key claim flow. Token hashed at rest, one-time, short expiry; lifecycle in `activity_log`.

### Join approval inbox

Join requests generate inbox alerts for `joins:approve` or admin; inline approve/reject; payload includes requester email (human), source IP, request type.

### Human inbox and agent-to-human delegation

Agents can assign tasks to humans when permitted; humans see assigned tasks in inbox; comment/status follow issue lifecycle guards.

### Agent join path (unified invite)

Same invite link can allow agent join; operator chooses "Join as agent", submits payload; pending approval → approve → agent record + one-time API key claim. Long-lived revocable keys, hash at rest, display once; revoke/regenerate from admin UI.

### API additions (proposed)

Inbox, assign-user, invites CRUD, invite accept/revoke, join-requests list/approve/reject, claim-api-key, members list, PATCH member permissions, admin promote/demote instance-admin, admin company-access get/put.

### Local mode UX

No login; local implicit board for audit; full instance/company settings as instance admin; invite/approval/permission UI available; public ingress out of scope.

### Agents in authenticated mode

Agents authenticate via `agent_api_keys`; same-company checks mandatory; assign-to-human is permission-gated.

### Instance settings surface

Minimal Instance Settings page for instance admins; API + CLI (`hive configure` / `hive onboard`); read-only indicators in UI until full UX.

### Implementation phases (product)

1. Mode and guardrails. 2. Human identity and memberships. 3. Permissions and assignment scope. 4. Invite workflow. 5. Human inbox + task assignment. 6. Agent self-join and token claim.

### Acceptance criteria

Local_trusted: no login, board UI immediately, implicit actor can manage settings/invites/approvals/grants. Authenticated: cannot start without auth; no mutation without authenticated actor; bootstrap instructions when no admin; onboard prints CEO invite URL when pending. One company_join link for human and agent; copy-link only; acceptance creates pending request; inbox alerts with approve/reject; only approved requests unlock access (human: membership+grants; agent: agent+claim). Agent enrollment same flow; worker credentials indefinite, revocable. Loopback-only for local. Multi-company memberships; instance admins promote/demote and manage company access; shared grant system; assignment scope enforced; agents assign to humans when allowed; all mutations company-scoped and logged.

### Locked decisions

1. Local_trusted: no login UX; implicit local board only. 2. Permissions: normalized `principal_permission_grants`. 3. Invite: copy-link only. 4. Bootstrap invite: CLI only. 5. Approval review: source IP only. 6. Agent API keys: indefinite by default, revoke/regenerate. 7. Local mode: full admin/settings/invite. 8. No public ingress for local; no `--dangerous-agent-ingress`.

---

## Part II — Implementation contract

If this part conflicts with prior exploratory notes, this document wins for execution.

### Implementation status

**Done:** Deployment mode (local_trusted | authenticated) in config, server, health, CLI; loopback guardrails; human auth tables and session resolution (Better Auth with builtin provider; Logto option present in config but not yet implemented); schema (instance_user_roles, company_memberships, principal_permission_grants, invites, join_requests); issues.assignee_user_id; actor resolution (user | agent | system; local → system id local-board, instance_admin); access service and routes (membership, permission, instance-admin, invite/join in `server/src/services/access.ts` and `server/src/routes/access.ts`); bootstrap CEO flow; health (deploymentMode, authReady, bootstrapStatus); joins:approve and assertCompanyPermission; invite create/accept/revoke and join-request approve/reject/claim-api-key.

**Remaining:** Chain-of-command scope enforcement; full inbox join-approval UX; agent self-join and one-time key claim flow; phase E cleanup. Optional: implement Logto resolver when switching from Better Auth.

### Architecture

**Deployment mode:** `deployment.mode = local_trusted | authenticated` in config (`packages/shared`, `server/src/config.ts`), surfaced in `/api/health`. Guardrails: local_trusted → loopback only; authenticated → auth provider/session configured (builtin or, when implemented, logto).

**Actor model:** `user` (session-authenticated), `agent` (bearer API key), `local_implicit_admin` (local only; in code principal type `system`, id `local-board`; see `packages/shared/src/types/principal.ts`, `server/src/auth/resolvers/builtin.ts`).

**Authorization:** Input `(company_id, principal_type, principal_id, permission_key, scope)`. Evaluation: resolve principal → instance_admin short-circuit → company membership (active) → grant+scope.

### Data model (concrete)

**Auth provider tables:** With builtin: Better Auth (user, session, account, verification). With Logto: provider-specific; principal shape unchanged.

**Hive tables:** instance_user_roles (user_id, role instance_admin); company_memberships (company_id, principal_type, principal_id, status, membership_role); principal_permission_grants (company_id, principal_type, principal_id, permission_key, scope, granted_by_user_id); invites (company_id, invite_type company_join|bootstrap_ceo, token_hash, allowed_join_types, defaults_payload, expires_at, invited_by_user_id, revoked_at, accepted_at); join_requests (invite_id, company_id, request_type, status, request_ip, requesting_user_id, request_email_snapshot, agent fields, approved/rejected metadata). issues: assignee_user_id; single-assignee invariant. agents: keep permissions JSON for transition; deprecate once grants wired.

**Migration:** Add tables/columns → backfill memberships/grants (local: runtime context; cloud: bootstrap on acceptance) → switch authz reads → remove legacy board checks.

### API contract

Health: deploymentMode, authReady, bootstrapStatus. Invites: POST companies/:id/invites, GET invites/:token, POST invites/:token/accept, POST invites/:id/revoke. Join requests: GET list, POST approve, POST reject, POST claim-api-key. Members: GET members, PATCH member permissions. Admin: promote/demote instance-admin, GET/PUT user company-access. Inbox: include pending join alerts when actor has joins:approve.

### Server implementation

Config/startup: config-schema, config.ts, index.ts, startup-banner; mode, bind host, auth readiness (builtin or logto when implemented). Human auth: `server/src/auth/*`; builtin uses Better Auth; logto resolver when added. Actor middleware: auth.ts, authz.ts, board-mutation-guard; map local → system principal, session → user, preserve agent bearer; replace assertBoard with requireInstanceAdmin, requireCompanyAccess, requireCompanyPermission. Services: access.ts (membership, permission, instance-admin, invite/join). Routes: access and related; company and permission checks; activity log for mutations. Activity log: invite.*, join.*, membership.*, permission.*, instance_admin.*, agent_api_key.*. Live events: join-request events and inbox refresh.

### CLI

`hive auth bootstrap-ceo` (create bootstrap invite, print URL). `hive onboard` (authenticated + bootstrap_pending → print URL; local → skip). Config: deployment mode, bind host.

### UI

AuthLogin/AuthSignup (authenticated mode); BootstrapPending; InviteLanding; InstanceSettings; join approval in Inbox; member/grant management in company settings. UX: unauthenticated → login; bootstrap pending → block with CLI guidance; invite landing → human vs agent path; inbox → join approval cards; local → no login, full settings.

### Security

Tokens and API keys hashed at rest; one-time key reveal. Local: loopback only; fail on non-loopback. Authenticated: no implicit board; session required for human mutations. Join: one request per invite; no access until approved. Rate limit invite accept and key claim; structured logging.

### Migration and compatibility

Keep board-dependent routes until permission helpers cover all; treat user.id as text; keep agents.permissions until cleanup migration.

### Testing

Unit: permission evaluator, join approval state machine, invite token lifecycle. Integration: authenticated unauthenticated → 401; local admin → success; invite accept → pending, no access; approve human/agent → membership/claim; cross-company denied; local non-loopback → startup failure. UI: login gate, bootstrap pending, invite landing, inbox approve/reject. Regression: worker credentials, task invariants, activity logging.

### Delivery phases

A: Foundations (mode, guardrails, auth skeleton, actor expansion). B: Schema and authz core. C: Invite + join backend. D: UI + CLI. E: Hardening (e2e, docs, legacy cleanup).

### Verification gate

`pnpm -r typecheck`, `pnpm test:run`, `pnpm build`. Record any skip.

### Done criteria

Behavior matches locked decisions; authenticated requires auth, local no login; unified invite + pending approval; shared membership+permission system; local loopback-only; inbox actionable join approvals; all mutations activity-logged.

---

## See also

- [DEPLOYMENT-MODES.md](../DEPLOYMENT-MODES.md) — canonical modes, board-claim flow.
- [K3S-LLM-DEPLOYMENT.md](../K3S-LLM-DEPLOYMENT.md) — production infrastructure.
