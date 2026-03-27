// Package workspaceartifact fetches a pre-built workspace tarball (ADR 007 option 3 — minimal).
package workspaceartifact

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// EnvEnabled returns true when HIVE_WORKSPACE_ARTIFACT_FETCH_ENABLED=1.
func EnvEnabled() bool {
	v := strings.TrimSpace(strings.ToLower(os.Getenv("HIVE_WORKSPACE_ARTIFACT_FETCH_ENABLED")))
	return v == "1" || v == "true"
}

// Fetch downloads url into destDir, verifies optional sha256 (hex), extracts tarball with tar -xzf.
func Fetch(ctx context.Context, url string, expectSHA256 string, destDir string) error {
	url = strings.TrimSpace(url)
	if url == "" {
		return fmt.Errorf("workspaceartifact: empty url")
	}
	if err := os.RemoveAll(destDir); err != nil {
		return err
	}
	if err := os.MkdirAll(destDir, 0o755); err != nil {
		return err
	}
	ctx2, cancel := context.WithTimeout(ctx, 30*time.Minute)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx2, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return fmt.Errorf("workspaceartifact: http %d", res.StatusCode)
	}
	arc := filepath.Join(destDir, "artifact.tgz")
	f, err := os.Create(arc)
	if err != nil {
		return err
	}
	h := sha256.New()
	w := io.MultiWriter(f, h)
	if _, err := io.Copy(w, io.LimitReader(res.Body, 512*1024*1024)); err != nil {
		_ = f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	if exp := strings.TrimSpace(strings.ToLower(expectSHA256)); exp != "" {
		got := hex.EncodeToString(h.Sum(nil))
		if got != exp {
			return fmt.Errorf("workspaceartifact: sha256 mismatch")
		}
	}
	cmd := exec.CommandContext(ctx2, "tar", "-xzf", arc, "-C", destDir)
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("tar: %w: %s", err, strings.TrimSpace(string(out)))
	}
	return nil
}
