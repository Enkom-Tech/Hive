# Regenerate CRDs / webhooks / RBAC (same as `make manifests`).
# Use from PowerShell when `make` or bash is not available.
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot
$version = if ($env:CONTROLLER_GEN_VERSION) { $env:CONTROLLER_GEN_VERSION } else { "v0.20.1" }
$pkg = "sigs.k8s.io/controller-tools/cmd/controller-gen@${version}"
& go run $pkg crd paths=./... webhook rbac:roleName=manager-role output:crd:artifacts:config=config/crd/bases
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
