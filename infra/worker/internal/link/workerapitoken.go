package link

import (
	"os"
	"path/filepath"
	"strings"
)

const workerApiTokenFileName = "worker-jwt"

func workerApiTokenFilePath(stateDir string) (string, error) {
	dir := strings.TrimSpace(stateDir)
	if dir == "" {
		d, err := os.UserConfigDir()
		if err != nil {
			return "", err
		}
		dir = filepath.Join(d, "hive-worker")
	}
	return filepath.Join(dir, workerApiTokenFileName), nil
}

// PersistWorkerApiToken stores the control-plane minted worker JWT for hive-worker mcp and REST calls.
func PersistWorkerApiToken(stateDir, token string) error {
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
	p := filepath.Join(dir, workerApiTokenFileName)
	return os.WriteFile(p, []byte(t+"\n"), 0o600)
}

// ReadWorkerApiToken returns the saved worker JWT, or empty if missing.
func ReadWorkerApiToken(stateDir string) string {
	p, err := workerApiTokenFilePath(stateDir)
	if err != nil {
		return ""
	}
	data, err := os.ReadFile(p)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(data))
}
