package link

import (
	"os"
	"path/filepath"
	"strings"
)

const linkTokenFileName = "link-token"

func linkTokenFilePath(stateDir string) (string, error) {
	dir := strings.TrimSpace(stateDir)
	if dir == "" {
		d, err := os.UserConfigDir()
		if err != nil {
			return "", err
		}
		dir = filepath.Join(d, "hive-worker")
	}
	return filepath.Join(dir, linkTokenFileName), nil
}

// PersistLinkToken stores the server-minted instance enrollment secret for the next WebSocket dial (replaces one-time provision token after first hello).
func PersistLinkToken(stateDir, token string) error {
	t := strings.TrimSpace(token)
	if t == "" {
		return nil
	}
	dir := strings.TrimSpace(stateDir)
	if dir == "" {
		d, err := os.UserConfigDir()
		if err != nil {
			return err
		}
		dir = filepath.Join(d, "hive-worker")
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	p := filepath.Join(dir, linkTokenFileName)
	return os.WriteFile(p, []byte(t+"\n"), 0o600)
}

// ReadPersistedLinkToken returns the saved link secret, or empty if missing.
func ReadPersistedLinkToken(stateDir string) string {
	p, err := linkTokenFilePath(stateDir)
	if err != nil {
		return ""
	}
	data, err := os.ReadFile(p)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(data))
}

// PersistedLinkTokenPathForLog returns the filesystem path to the persisted link-token file for user-facing log lines.
func PersistedLinkTokenPathForLog(stateDir string) string {
	p, err := linkTokenFilePath(stateDir)
	if err != nil {
		return ""
	}
	return p
}
