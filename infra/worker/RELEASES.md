# hive-worker release artifacts

Operators publish **pre-built binaries** for the managed worker (Go code in this directory) as GitHub release assets and/or mirror them to private HTTPS storage. The control plane **`GET /api/worker-downloads`** endpoint (see control-plane server) resolves download URLs for the onboarding UI.

## Minimum control-plane version (unified dispatch / ADR 003)

Use a control-plane build that includes **ADR 003** (instance-keyed registry, optional Redis cross-replica delivery, placement retry fields) if the worker sends **`agentId` on all `status` / `log` messages** and advertises **`hello.capabilities.pool`**. Older control planes still accept extra JSON fields but may not route pool telemetry optimally until upgraded.

## Archive names (strict)

For tag `vX.Y.Z` (semver with `v` prefix), attach these files to the release (or mirror the same names):

| Asset |
|-------|
| `hive-worker_vX.Y.Z_linux_amd64.tar.gz` |
| `hive-worker_vX.Y.Z_linux_arm64.tar.gz` |
| `hive-worker_vX.Y.Z_darwin_amd64.tar.gz` |
| `hive-worker_vX.Y.Z_darwin_arm64.tar.gz` |
| `hive-worker_vX.Y.Z_windows_amd64.zip` |

**Contents**

- `.tar.gz` archives: single file `hive-worker` at repo root of the archive.
- `.zip` (Windows): single file `hive-worker.exe` at the root of the zip.

## SHA256SUMS

Generate a standard checksum file over **only** the five archives above, e.g.:

```bash
(cd dist && shasum -a 256 hive-worker_*.tar.gz hive-worker_*.zip > SHA256SUMS)
```

On Linux you can use `sha256sum` instead of `shasum -a 256`. Upload `SHA256SUMS` next to the archives.

## Verified install script (Linux)

For Linux hosts with `curl`, `jq`, and `sha256sum`, see [`scripts/install-hive-worker.sh`](scripts/install-hive-worker.sh). Point **`HIVE_WORKER_MANIFEST_URL`** at a JSON document listing `url` and `sha256` per version and architecture (`linux_amd64`, `linux_arm64`).

## Manifest JSON (`manifest-only` mode)

When the control plane **cannot** call `api.github.com` (air-gap) or all URLs are internal, set **`HIVE_WORKER_MANIFEST_URL`** to an HTTPS URL returning JSON with this shape:

```json
{
  "schemaVersion": 1,
  "tag": "v0.2.7",
  "sha256sumsUrl": "https://example.internal/hive-worker/v0.2.7/SHA256SUMS",
  "artifacts": [
    {
      "filename": "hive-worker_v0.2.7_linux_amd64.tar.gz",
      "url": "https://example.internal/hive-worker/v0.2.7/hive-worker_v0.2.7_linux_amd64.tar.gz",
      "sha256": "optional; if omitted server may fetch sha256sumsUrl"
    }
  ]
}
```

- **`schemaVersion`**: must be `1`.
- **`tag`**: release tag string.
- **`artifacts`**: each entry must include **`filename`** and **`url`** (final download URL). **`sha256`** is optional per file.
- **`sha256sumsUrl`**: optional; control plane may fetch it to fill missing `sha256` values.

Build with [`scripts/build-release.sh`](scripts/build-release.sh); use `--url-base` to fill `url` fields, or inject URLs in CI after upload.

## Control-plane env precedence

1. **`HIVE_WORKER_MANIFEST_URL`** — If set, the server loads **only** this manifest (no GitHub API).
2. Otherwise **`HIVE_WORKER_RELEASES_REPO`** + **`HIVE_WORKER_RELEASE_TAG`** (default tag `v` + control-plane `APP_VERSION`) — GitHub **releases/tags/{tag}** API.
3. **`HIVE_WORKER_ARTIFACT_BASE_URL`** — **GitHub mode only**: same filenames are expected at `{base}/{filename}`; returned URLs point at this mirror while the server still lists assets from GitHub.

Optional **`HIVE_GITHUB_TOKEN`** for rate limits or private `HIVE_WORKER_RELEASES_REPO`.

## Private mirror layout

If using **`HIVE_WORKER_ARTIFACT_BASE_URL`**, set it to the prefix that already includes the tag directory, e.g. `https://cdn.example.com/hive-worker/v0.2.7` (no trailing slash). Files must include `SHA256SUMS` at `{base}/SHA256SUMS` when you want the UI to link checksum verification.

## Building locally

```bash
./scripts/build-release.sh v0.2.7
# optional: ./scripts/build-release.sh v0.2.7 --url-base 'https://cdn.example/hive-worker/v0.2.7'
```

Outputs under `dist/`: archives, `SHA256SUMS`, and `hive-worker_v0.2.7.manifest.json`.

**CI / release gate:** Before publishing assets, verify checksums match the five archives (e.g. `(cd dist && sha256sum -c SHA256SUMS)` on Linux or `shasum -a 256 -c SHA256SUMS` on macOS). Fail the pipeline on any mismatch.

## Docker Compose and systemd (reference)

- **Compose:** [`docker-compose.drone.yml`](docker-compose.drone.yml) with [`.env.drone.example`](.env.drone.example) — volumes for state, workspace, and provision cache; set `HIVE_CONTROL_PLANE_URL` and `HIVE_DRONE_PROVISION_TOKEN` (or agent credentials). See [worker deployment matrix](../control-plane/docs/deploy/worker-deployment-matrix.md).
- **systemd:** [`hive-worker.drone.example.service`](hive-worker.drone.example.service) — use with `/etc/hive-worker/environment` for secrets.

The default [`Dockerfile`](Dockerfile) produces a **distroless** image (no `apt`/`npm`/`docker` in-container). Bake extra tools into a derived image if your adapter manifest needs install hooks, or rely on **`HIVE_ADAPTER_*_URL`** / **`HIVE_PROVISION_MANIFEST_URL`** to fetch binaries only. Optional **`HIVE_PROVISION_MANIFEST_HOOKS=1`** runs `aptPackages` / `npmGlobal` / `dockerImages` from the manifest at startup (requires those binaries on `PATH`). When the manifest URL is company-scoped (`/api/companies/.../worker-runtime/manifest`), the worker sends **`Authorization: Bearer`** using **`HIVE_PROVISION_MANIFEST_BEARER`** or the same credentials as the WebSocket link (`HIVE_DRONE_PROVISION_TOKEN` until consumed, then enrollment/API key or persisted `link-token`). When **`HIVE_PROVISION_MANIFEST_PUBLIC_KEY`** is set, the worker **requires** a valid **`X-Hive-Manifest-Signature`** (Ed25519) on the manifest HTTP response before parsing JSON (control plane: **`HIVE_WORKER_PROVISION_MANIFEST_SIGNING_KEY_FILE`** or inline key). For production without in-process hooks, see [`PROVISIONER-SPLIT.md`](PROVISIONER-SPLIT.md).

## Pipe installer (`install.sh` / `install.ps1`)

The control plane generates these scripts at `GET /api/worker-downloads/install.sh` and `install.ps1`.

**Default (global install)** — same behavior on every supported OS:

| Environment | Script | Install directory | PATH |
|-------------|--------|-------------------|------|
| Linux, macOS, WSL | `install.sh` (run **inside** WSL for WSL) | `$HOME/.local/bin` | Idempotent block in `~/.profile`, plus `~/.zshrc` or `~/.zprofile` when zsh, plus `~/.bashrc` when bash or file exists |
| Windows (native PowerShell) | `install.ps1` | `%USERPROFILE%\.local\bin` | User `Path` (prepend if missing); **also** updates `$env:Path` in the **current** PowerShell session so `worker` works immediately without opening a new window |

The installer places **`hive-worker`** (or `hive-worker.exe`) in that directory and adds the same names **`worker`** and **`drone`** (symlinks on Unix; symlink with copy fallback on Windows). On **Unix**, open a **new** terminal (or `source ~/.profile` / your shell rc) so `PATH` picks up the bin dir; on **Windows PowerShell**, the running session is updated as well as persistent User `Path`.

**Overrides**

- **`HIVE_WORKER_INSTALL_DIR`** — absolute install directory (no trailing slash); applies to both bash and PowerShell scripts.
- **`HIVE_WORKER_EXTRACT_ONLY=1`** (or `true` / `yes`) — legacy behavior: extract only into the **current directory**, no PATH changes, no `worker`/`drone` in a global bin. Use for CI or when you manage layout yourself.
- **`HIVE_WORKER_SKIP_SHA256=1`** — skip SHA256 verification of the downloaded archive when the control plane provided a hash (`install.sh` / `install.ps1`).

**Worker HTTP (health / metrics)**

- **`HIVE_WORKER_HTTP_ADDR`** — TCP listen address for `/health` and `/metrics` (default `:8080`). Example: `127.0.0.1:18080`.
- **`HIVE_WORKER_HTTP_PORT_AUTO`** — if the preferred port is busy, try the next ports on the same host (up to 100 steps). When unset: enabled when `HIVE_WORKER_HTTP_ADDR` is unset (common for laptops where `:8080` is already taken); disabled when you set a non-empty `HIVE_WORKER_HTTP_ADDR`. Set explicitly to `0` or `false` to always fail fast on the first bind attempt. The process logs when it moves to a fallback port—point probes and bookmarks at the address shown in logs if you rely on auto.

**Git Bash on Windows** can run `install.sh`; prefer **`install.ps1`** in native PowerShell for PATH updates.

**fish** / other shells: add `$HOME/.local/bin` to `PATH` manually if you do not use bash/zsh profile wiring.

## Board link, hello, and multiple slots on one host

- **`HIVE_WORKER_STATE_DIR`** — Optional. Directory where **`instance-id`** is stored and reused across reconnects. That UUID is sent as **`instanceId`** in the post-connect **`hello`** JSON so the control plane can group **board agents** (managed_worker identities) under one **drone** row. Default: `{UserConfigDir}/hive-worker` (OS-specific; e.g. `~/.config/hive-worker` on Linux). The same directory holds **`link-token`** (mode `0600`): after the first successful **`hello`** with a **`hive_dpv_…`** secret, a current control plane sends a **`link_token`** control message with a long-lived **`hive_wen_…`** instance enrollment secret; the worker writes it here for reconnect when you do not set a link secret in env.
- **Link token env precedence** — **`HIVE_AGENT_KEY`** (board agent API key or a fresh **`hive_wen_…`** for testing) **and** **`HIVE_CONTROL_PLANE_TOKEN`** are evaluated **before** the **`link-token`** file, so an explicit credential in the shell is not shadowed by an old persisted file. Then **`link-token`**, then **`HIVE_DRONE_PROVISION_TOKEN`**, so a consumed **`hive_dpv_…`** accidentally left in the environment does not override the server-minted file.
- **`HIVE_DRONE_PROVISION_TOKEN`** — Optional. Short-lived **`hive_dpv_…`** secret from `POST /api/companies/{companyId}/drone-provisioning-tokens` (board UI: **Generate host bootstrap token**). Use with **`HIVE_CONTROL_PLANE_URL`** (or **`HIVE_CONTROL_PLANE_WS_URL`**) **without** **`HIVE_AGENT_ID`** to connect before any board identity exists; token is consumed on first **`hello`**. Then bind identities from the board (HTTP or per-agent enrollment). After **`link-token`** is written, remove this env from persistent configuration if you still see **`401`** reconnects (the process may be re-sending the consumed secret).
- **`HIVE_WORKER_LINKS_JSON`** — Optional. JSON array of objects `{"agentId":"<uuid>","token":"<secret>"}`. When set and non-empty after parsing, **hive-worker** opens **one outbound WebSocket per element**, using the same WS base URL as **`HIVE_CONTROL_PLANE_WS_URL`** / **`HIVE_CONTROL_PLANE_URL`**. Use this to link **several board agents** from a **single process** (e.g. COO + engineer on one VM). When unset or invalid, behavior falls back to one link from **`HIVE_AGENT_ID`** + **`HIVE_AGENT_KEY`** / **`HIVE_CONTROL_PLANE_TOKEN`** (or **`HIVE_DRONE_PROVISION_TOKEN`** alone for provision mode).
- **Hello:** Right after each WebSocket connects, the worker sends `{ "type": "hello", "hostname", "os", "arch", "version", "instanceId" }` (see `control-plane/doc/DRONE-SPEC.md` §3.1).

## Push pairing (no enrollment token)

With a **pairing window** open for the managed worker agent on the board, the binary can enroll anonymously:

```bash
export HIVE_CONTROL_PLANE_URL='https://your-board.example'
export HIVE_AGENT_ID='<agent-uuid>'
./hive-worker pair
```

Flags work too: `./hive-worker pair -control-plane-url '…' -agent-id '<uuid>'`.

**Systemd / scripts:** set `HIVE_PAIRING=1` with `HIVE_CONTROL_PLANE_URL`, `HIVE_AGENT_ID`, and **without** `HIVE_AGENT_KEY` / `HIVE_CONTROL_PLANE_TOKEN` — the process runs the same pairing flow then continues as the normal worker. The `pair` subcommand wins if both are set.

TLS uses the host trust store (`HTTPS_PROXY` / `NO_PROXY` apply via the default HTTP client). Corporate TLS interception requires a corporate root on the machine.

### Pipe install + pair

The board serves `GET /api/worker-downloads/install.sh` and `install.ps1`. By default the script **installs to `~/.local/bin` or `%USERPROFILE%\.local\bin`** (see table above), then optionally runs pairing. If you set `HIVE_PAIRING=1` when piping, after install it runs **`hive-worker pair`** from that directory (not `./hive-worker` in `PWD`). With **`HIVE_WORKER_EXTRACT_ONLY=1`**, extract stays in the current directory and pairing uses `./hive-worker` there.

The script bakes in the board HTTP origin from the request (Host / `X-Forwarded-*`) or falls back to `auth.publicBaseUrl` when the host header is missing.

Examples (pairing window must be open):

```bash
curl -fsSL 'https://board.example/api/worker-downloads/install.sh?agentId=<uuid>' | HIVE_PAIRING=1 bash
```

```powershell
$env:HIVE_PAIRING='1'; irm 'https://board.example/api/worker-downloads/install.ps1?agentId=<uuid>' | iex
```

### Pipe install + provision (drone bootstrap)

Mint `hive_dpv_…` from the board (**Generate host bootstrap token** on Workers). The installer **bakes the board HTTP origin** into the script from the `GET` request (Host / forwarded headers), and sets **`HIVE_CONTROL_PLANE_URL`** for **`hive-worker`** when you did not set it — so you normally only pass **`HIVE_DRONE_PROVISION_TOKEN`** into the process that runs the piped script. Set **`HIVE_CONTROL_PLANE_URL`** yourself only when the worker must use a **different** API base than the URL you used to download `install.sh` / `install.ps1`. If **`HIVE_PAIRING=1`**, the pairing path above takes precedence.

```bash
curl -fsSL 'https://board.example/api/worker-downloads/install.sh' \
  | HIVE_DRONE_PROVISION_TOKEN='hive_dpv_…' bash
```

```powershell
$env:HIVE_DRONE_PROVISION_TOKEN='hive_dpv_…'
irm 'https://board.example/api/worker-downloads/install.ps1' | iex
```

See `control-plane/doc/MANAGED-WORKER-ARCHITECTURE.md` for architecture context.

#### Troubleshooting (drone bootstrap)

| Symptom | What it usually means |
|--------|------------------------|
| `link: connect failed: websocket: bad handshake` | The HTTP upgrade to `/api/workers/link` did not return **101 Switching Protocols**. The control plane rejected the connection (often **401** with body `invalid token` or `missing token`). |
| Log line includes `http_status=401` | The provisioning token is wrong for this server’s database: expired, already consumed, typo, placeholder text instead of the full `hive_dpv_…` string, or minted before a DB reset / different `DATABASE_URL` than the running board. **Or** the process is still sending the **consumed** `hive_dpv_…` from a unit file while a **`link-token`** file already exists — remove **`HIVE_DRONE_PROVISION_TOKEN`** from the service env so **`TokenFromEnv`** uses the persisted **`hive_wen_…`**. Otherwise mint a **new** `hive_dpv_…` from **Generate host bootstrap token** and retry. |
| Empty Workers page, same log | No row is created until the WebSocket succeeds **and** the worker sends a `hello` with a valid UUID `instanceId`. Fix the handshake first; then check worker logs for `link: instance id:` errors if the row still does not appear. |

**Control plane logs** (on connect): success shows `worker link connected (provision; awaiting hello)` then `provision hello completed; instance registered`. A rejected token does not emit those lines; use worker logs (above) for the HTTP status.

**Raw handshake check** (optional): from the same host, open a WebSocket to `ws://127.0.0.1:<port>/api/workers/link?token=<full hive_dpv_…>` (e.g. `wscat` or your client). **101** means the token is accepted; **401** means it is not.
