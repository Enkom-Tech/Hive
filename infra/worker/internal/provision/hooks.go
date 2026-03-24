package provision

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/exec"
	"regexp"
	"runtime"
	"strings"
)

const manifestHooksEnv = "HIVE_PROVISION_MANIFEST_HOOKS"

var (
	debNameRe   = regexp.MustCompile(`^[a-z0-9][a-z0-9+.-]*$`)
	npmGlobalRe = regexp.MustCompile(`^[a-zA-Z0-9@^~./_\-]+$`)
	dockerRefRe = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9._/@:+-]*$`)
)

// ManifestHooksEnabled is true when HIVE_PROVISION_MANIFEST_HOOKS=1 (opt-in; requires a shell-capable image for apt/npm).
func ManifestHooksEnabled() bool {
	return strings.TrimSpace(os.Getenv(manifestHooksEnv)) == "1"
}

// ApplyManifestHooksFromEnv loads the provision manifest and runs optional apt / npm / docker hooks.
// No-op when hooks are disabled or no manifest is configured. Requires binaries on PATH when respective lists are non-empty.
func ApplyManifestHooksFromEnv(ctx context.Context, client *http.Client) error {
	if !ManifestHooksEnabled() {
		return nil
	}
	m, err := LoadProvisionManifest(ctx, client)
	if err != nil {
		return err
	}
	if m == nil {
		return fmt.Errorf("%s is set but no provision manifest is configured", manifestHooksEnv)
	}
	return applyManifestHooks(ctx, m)
}

func applyManifestHooks(ctx context.Context, m *ProvisionManifest) error {
	if len(m.AptPackages) == 0 && len(m.NpmGlobal) == 0 && len(m.DockerImages) == 0 {
		return nil
	}
	if runtime.GOOS == "windows" {
		log.Printf("provision hooks: skipping apt/npm/docker hooks on windows")
		return nil
	}
	aptEnv := map[string]string{"DEBIAN_FRONTEND": "noninteractive"}
	aptUpdated := false
	for _, pkg := range m.AptPackages {
		pkg = strings.TrimSpace(pkg)
		if pkg == "" {
			continue
		}
		if !debNameRe.MatchString(pkg) {
			return fmt.Errorf("invalid aptPackages entry %q", pkg)
		}
		if !aptUpdated {
			if err := runLookPath(ctx, "apt-get", []string{"update", "-qq"}, aptEnv); err != nil {
				return fmt.Errorf("apt-get update: %w", err)
			}
			aptUpdated = true
		}
		if err := runLookPath(ctx, "apt-get", []string{"install", "-y", "-qq", pkg}, aptEnv); err != nil {
			return fmt.Errorf("apt install %q: %w", pkg, err)
		}
	}
	for _, spec := range m.NpmGlobal {
		spec = strings.TrimSpace(spec)
		if spec == "" {
			continue
		}
		if !npmGlobalRe.MatchString(spec) || strings.Contains(spec, "..") {
			return fmt.Errorf("invalid npmGlobal entry %q", spec)
		}
		if err := runLookPath(ctx, "npm", []string{"install", "-g", "--no-fund", "--no-audit", spec}, nil); err != nil {
			return fmt.Errorf("npm install -g %q: %w", spec, err)
		}
	}
	for _, img := range m.DockerImages {
		img = strings.TrimSpace(img)
		if img == "" {
			continue
		}
		if !dockerRefRe.MatchString(img) || strings.Contains(img, "..") {
			return fmt.Errorf("invalid dockerImages entry %q", img)
		}
		if err := runLookPath(ctx, "docker", []string{"pull", img}, nil); err != nil {
			return fmt.Errorf("docker pull %q: %w", img, err)
		}
	}
	return nil
}

func runLookPath(ctx context.Context, bin string, args []string, extraEnv map[string]string) error {
	exe, err := exec.LookPath(bin)
	if err != nil {
		return fmt.Errorf("%s not on PATH", bin)
	}
	cmd := exec.CommandContext(ctx, exe, args...)
	cmd.Env = os.Environ()
	for k, v := range extraEnv {
		cmd.Env = append(cmd.Env, k+"="+v)
	}
	out, err := cmd.CombinedOutput()
	if err != nil {
		if len(out) > 0 {
			return fmt.Errorf("%w: %s", err, strings.TrimSpace(string(out)))
		}
		return err
	}
	return nil
}
