# Route → permission matrix (board HTTP API)

This matrix complements `assertCompanyAccess` (company scope) and `boardMutationGuard` (browser-origin CSRF-style gate). **Mutations must use `assertCompanyPermission`** with a `PermissionKey` unless noted.

## Read model

- Default company read: **`company:read`** via `assertCompanyRead` (maps to `assertCompanyPermission(..., "company:read")`).
- **Instance admin** and **`system`** principals bypass grant checks where implemented in `authz.assertCompanyPermission`.
- **`assertBoard`**: still used where there is **no `companyId`** yet (e.g. `GET /api/companies`, `GET /api/companies/stats`) — requires a human/system board session, not an agent API key.

## Membership role presets

| Role     | Grants (union with explicit `principal_permission_grants`) |
|----------|------------------------------------------------------------|
| viewer   | `company:read`, `costs:read`                               |
| operator | viewer keys + task/agent/issue mutations per `role-presets.ts` |
| admin    | operator + `company:settings`, `joins:approve`, `secrets:manage`, `plugins:manage`, `models:train`, … |

Source: `packages/shared/src/rbac/role-presets.ts`.

## Representative routes

| Area | Method / path | Permission / rule |
|------|----------------|-------------------|
| Companies | `GET /companies`, `GET /companies/stats` | `assertBoard` + principal filter |
| Companies | `POST /companies` | `assertInstanceAdmin` |
| Companies | `GET /companies/:id` | `company:read` |
| Companies | Import new company | `assertInstanceAdmin`; existing target `company:settings` |
| Join | `GET .../join-requests` | `company:read` |
| Join | Approve / reject | `joins:approve` |
| Plugins | `GET .../plugins` | `company:read` |
| Plugins | `POST/PATCH .../plugins` | `plugins:manage` |
| Agents | List / detail | `company:read` (+ config redaction rules) |
| Agents | Create | `agents:create` (via `assertCanCreateAgentsForCompany`) |
| Agents | Update | `agents:create` |
| Agents | Keys CRUD | `secrets:manage` |
| Agents | Link enrollment token | `company:settings` |
| Agents | Pause / resume / terminate / delete | `agents:create` |
| Agents | Runtime session reset | `runs:board` |
| Worker pairing | Open window, approve, reject | `company:settings` |
| Worker pairing | List pending | `company:read` |
| Issues | Writes / assign | `issues:write`, `tasks:assign` (+ assign scope when grant uses `tasks:assign_scope`) |
| Costs | Read / manage | `costs:read` / `costs:manage` |
| Sidebar badges | `GET .../sidebar-badges` | `company:read`; response includes `canApproveJoinRequests` |
| Model training | `GET/POST .../companies/:id/model-training-runs` (+ cancel, promote, dataset-export) | `models:train` (+ `company:read` for list/detail/export when using board session) |

## Worker API

Worker JWT routes (`/api/worker-api/*`) use **per-route worker checks**, not human RBAC. Plugin tool discovery: `GET /api/worker-api/plugin-tools?agentId=` (worker instance auth).

## Environment

- **`HIVE_RBAC_ENFORCE_FOR_LOCAL_BOARD`**: when `true` / `1`, the synthetic `local-board` user is not exempt from `assertCompanyPermission` (for strict RBAC tests and CI).
- **`HIVE_PLUGIN_HOST_SECRET`**: enables `POST /api/internal/plugin-host/rpc` for OOP plugins (Bearer).
