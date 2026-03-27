// Package workspacematerialize clones a git repo under the worker workspace when the control plane
// delegates execution workspace materialization (ADR 007 option 2 — minimal v1).
package workspacematerialize

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

const (
	defaultTimeout = 20 * time.Minute
)

// Enabled returns true when HIVE_WORKSPACE_MATERIALIZE_ENABLED is 1/true.
func Enabled() bool {
	v := strings.TrimSpace(strings.ToLower(os.Getenv("HIVE_WORKSPACE_MATERIALIZE_ENABLED")))
	return v == "1" || v == "true" || v == "yes"
}

// Spec describes clone inputs from run context JSON (hiveWorkspaceMaterialize).
type Spec struct {
	RepoURL    string
	Ref        string
	BranchName string
}

func (s Spec) Valid() bool {
	return strings.TrimSpace(s.RepoURL) != "" && strings.TrimSpace(s.Ref) != ""
}

func timeout() time.Duration {
	sec := strings.TrimSpace(os.Getenv("HIVE_WORKSPACE_MATERIALIZE_TIMEOUT_SEC"))
	if sec == "" {
		return defaultTimeout
	}
	var n int
	_, _ = fmt.Sscanf(sec, "%d", &n)
	if n <= 0 || n > 3600 {
		return defaultTimeout
	}
	return time.Duration(n) * time.Second
}

// Materialize clones repoURL into workspaceRoot/hive-materialize/<safeDir> and checks out branchName or ref.
func Materialize(ctx context.Context, workspaceRoot string, spec Spec) (cwd string, err error) {
	root := strings.TrimSpace(workspaceRoot)
	if root == "" {
		return "", fmt.Errorf("workspacematerialize: empty workspace root")
	}
	if !spec.Valid() {
		return "", fmt.Errorf("workspacematerialize: invalid spec")
	}
	if err := os.MkdirAll(root, 0o755); err != nil {
		return "", err
	}
	base := filepath.Join(root, "hive-materialize")
	if err := os.MkdirAll(base, 0o755); err != nil {
		return "", err
	}
	dirName := sanitizeDirName(spec.BranchName)
	if dirName == "" {
		dirName = "default"
	}
	dest := filepath.Join(base, dirName)
	_ = os.RemoveAll(dest)

	ctx2, cancel := context.WithTimeout(ctx, timeout())
	defer cancel()

	token := strings.TrimSpace(os.Getenv("HIVE_WORKSPACE_MATERIALIZE_GIT_TOKEN"))
	repoURL := spec.RepoURL
	if token != "" && strings.HasPrefix(strings.ToLower(repoURL), "https://") {
		// https://host/path -> https://x-access-token:TOKEN@host/path
		repoURL = injectHTTPSCredential(repoURL, token)
	}

	cmd := exec.CommandContext(ctx2, "git", "clone", "--depth", "1", "--single-branch", "--branch", strings.TrimSpace(spec.Ref), repoURL, dest)
	cmd.Env = append(os.Environ(),
		"GIT_TERMINAL_PROMPT=0",
		"GIT_CONFIG_GLOBAL=/dev/null",
		"GIT_CONFIG_SYSTEM=/dev/null",
	)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("git clone: %w: %s", err, strings.TrimSpace(string(out)))
	}

	br := strings.TrimSpace(spec.BranchName)
	if br != "" && br != strings.TrimSpace(spec.Ref) {
		co := exec.CommandContext(ctx2, "git", "-C", dest, "checkout", "-B", br, "HEAD")
		co.Env = cmd.Env
		out2, err2 := co.CombinedOutput()
		if err2 != nil {
			return "", fmt.Errorf("git checkout: %w: %s", err2, strings.TrimSpace(string(out2)))
		}
	}

	return dest, nil
}

func sanitizeDirName(s string) string {
	var b strings.Builder
	for _, r := range strings.TrimSpace(s) {
		switch r {
		case '/', '\\', ':', '\x00':
			b.WriteByte('_')
		default:
			b.WriteRune(r)
		}
	}
	out := b.String()
	if len(out) > 120 {
		out = out[:120]
	}
	return out
}

func injectHTTPSCredential(rawURL, token string) string {
	u := strings.TrimSpace(rawURL)
	rest := strings.TrimPrefix(u, "https://")
	if rest == u {
		return u
	}
	return "https://x-access-token:" + token + "@" + rest
}
