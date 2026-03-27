# DeepCopy + CRD + webhook + RBAC (same as `make generate`).
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot
$version = if ($env:CONTROLLER_GEN_VERSION) { $env:CONTROLLER_GEN_VERSION } else { "v0.20.1" }
$pkg = "sigs.k8s.io/controller-tools/cmd/controller-gen@${version}"
& go run $pkg object:headerFile=hack/boilerplate.go.txt paths="./..."
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& go run $pkg crd webhook rbac:roleName=manager-role output:crd:artifacts:config=config/crd/bases
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
