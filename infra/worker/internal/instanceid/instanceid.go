// Package instanceid persists a stable per-host UUID for worker hello / instance grouping.
package instanceid

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

func newUUID() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	h := hex.EncodeToString(b[:])
	return fmt.Sprintf("%s-%s-%s-%s-%s", h[0:8], h[8:12], h[12:16], h[16:20], h[20:32])
}

// Ensure returns a stable instance id, creating stateDir and a file on first use.
// If stateDir is empty, uses UserConfigDir/hive-worker.
func Ensure(stateDir string) (string, error) {
	dir := strings.TrimSpace(stateDir)
	if dir == "" {
		d, err := os.UserConfigDir()
		if err != nil {
			return "", err
		}
		dir = filepath.Join(d, "hive-worker")
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", err
	}
	p := filepath.Join(dir, "instance-id")
	data, err := os.ReadFile(p)
	if err == nil {
		id := strings.TrimSpace(string(data))
		if id != "" {
			return id, nil
		}
	}
	id := newUUID()
	if err := os.WriteFile(p, []byte(id+"\n"), 0o600); err != nil {
		return "", err
	}
	return id, nil
}
