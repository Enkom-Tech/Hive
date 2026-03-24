// Package adapter provides an allowlisted registry of execution adapters (executors) keyed by adapter name.
// Commands are operator-configured via env; the run payload may specify an adapter key to select which executor to use.
package adapter

import (
	"context"
	"os"
	"strings"

	"github.com/Enkom-Tech/hive-worker/internal/executor"
	"github.com/Enkom-Tech/hive-worker/internal/provision"
)

const (
	envPrefix   = "HIVE_ADAPTER_"
	envSuffix   = "_CMD"
	envAgent    = "_AGENT"
	acpxCmdName = "acpx"
)

// Registry maps adapter keys to allowlisted executors. Commands come only from operator config (env), never from the run request.
type Registry struct {
	defaultExec executor.Executor
	byKey       map[string]executor.Executor
	provisioner provision.Provisioner
}

// provisioningExecutor runs Provision on first Run, then delegates to ProcessExecutor with the resolved path.
type provisioningExecutor struct {
	adapterKey  string
	command     string
	provisioner provision.Provisioner
}

func (p *provisioningExecutor) Run(ctx context.Context, payload *executor.Payload, workspaceDir string) ([]byte, []byte, error) {
	path, err := p.provisioner.Provision(ctx, p.adapterKey)
	if err != nil {
		return nil, nil, err
	}
	cmd := p.command
	if path != "" {
		cmd = path
	}
	pe := &executor.ProcessExecutor{Command: cmd}
	return pe.Run(ctx, payload, workspaceDir)
}

// getAdapterAgent returns HIVE_ADAPTER_<key>_AGENT (for ACP adapters).
func getAdapterAgent(key string) string {
	return strings.TrimSpace(os.Getenv(envPrefix + key + envAgent))
}

// provisioningAcpxExecutor provisions the acpx binary then runs AcpxExecutor with the resolved path.
type provisioningAcpxExecutor struct {
	adapterKey   string
	acpxPath     string
	agentName    string
	provisioner  provision.Provisioner
}

func (p *provisioningAcpxExecutor) Run(ctx context.Context, payload *executor.Payload, workspaceDir string) ([]byte, []byte, error) {
	path, err := p.provisioner.Provision(ctx, p.adapterKey)
	if err != nil {
		return nil, nil, err
	}
	acpxPath := p.acpxPath
	if path != "" {
		acpxPath = path
	}
	ex := &executor.AcpxExecutor{AcpxPath: acpxPath, AgentName: p.agentName}
	return ex.Run(ctx, payload, workspaceDir)
}

// NewRegistryFromEnv builds a registry from environment variables (no provisioning).
//   - HIVE_ADAPTER_DEFAULT_CMD or HIVE_TOOL_CMD for the default executor (used when adapterKey is empty or unknown)
//   - HIVE_ADAPTER_<key>_CMD for named adapters (e.g. HIVE_ADAPTER_claude_CMD=claude, HIVE_ADAPTER_codex_CMD=codex)
func NewRegistryFromEnv() *Registry {
	return newRegistryFromEnv(nil)
}

// NewRegistryFromEnvWithProvisioner builds a registry and uses the provisioner for adapters that have HIVE_ADAPTER_<key>_URL set.
// If prov is nil, behaves like NewRegistryFromEnv (no provisioning).
func NewRegistryFromEnvWithProvisioner(prov provision.Provisioner) *Registry {
	return newRegistryFromEnv(prov)
}

func newRegistryFromEnv(prov provision.Provisioner) *Registry {
	defaultCmd := os.Getenv("HIVE_ADAPTER_DEFAULT_CMD")
	if defaultCmd == "" {
		defaultCmd = os.Getenv("HIVE_TOOL_CMD")
	}
	defaultExec := &executor.ProcessExecutor{Command: defaultCmd}

	byKey := make(map[string]executor.Executor)
	for _, env := range os.Environ() {
		name, val, ok := strings.Cut(env, "=")
		if !ok {
			continue
		}
		if !strings.HasPrefix(name, envPrefix) || !strings.HasSuffix(name, envSuffix) {
			continue
		}
		key := strings.TrimSuffix(name[len(envPrefix):], envSuffix)
		if key == "" {
			continue
		}
		if strings.EqualFold(key, "DEFAULT") {
			if val != "" {
				defaultExec = &executor.ProcessExecutor{Command: val}
			}
			continue
		}
		if val == "" {
			continue
		}
		// ACP adapter: _CMD=acpx and _AGENT=<name> => AcpxExecutor
		if agent := getAdapterAgent(key); agent != "" && strings.EqualFold(strings.TrimSpace(val), acpxCmdName) {
			if prov != nil && provision.GetAdapterURL(key) != "" {
				byKey[key] = &provisioningAcpxExecutor{adapterKey: key, acpxPath: val, agentName: agent, provisioner: prov}
			} else {
				byKey[key] = &executor.AcpxExecutor{AcpxPath: val, AgentName: agent}
			}
			continue
		}
		if executor.IsContainerEnabled(key) {
			if img := executor.GetAdapterImage(key); img != "" {
				byKey[key] = &executor.ContainerExecutor{Image: img, Command: val}
				continue
			}
		}
		if prov != nil && provision.GetAdapterURL(key) != "" {
			byKey[key] = &provisioningExecutor{adapterKey: key, command: val, provisioner: prov}
			continue
		}
		byKey[key] = &executor.ProcessExecutor{Command: val}
	}

	return &Registry{
		defaultExec: defaultExec,
		byKey:       byKey,
		provisioner: prov,
	}
}

// Executor returns the executor for the given adapter key. Empty or unknown key returns the default executor.
// The returned executor is always non-nil (allowlisted; command from operator config only).
func (r *Registry) Executor(adapterKey string) executor.Executor {
	if adapterKey == "" {
		return r.defaultExec
	}
	if ex, ok := r.byKey[adapterKey]; ok {
		return ex
	}
	return r.defaultExec
}

// Run runs the task using the executor selected by adapterKey. It is a convenience for handler code.
func (r *Registry) Run(ctx context.Context, adapterKey string, payload *executor.Payload, workspaceDir string) (stdout, stderr []byte, err error) {
	return r.Executor(adapterKey).Run(ctx, payload, workspaceDir)
}
