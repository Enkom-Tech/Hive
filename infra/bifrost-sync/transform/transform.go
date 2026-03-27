package transform

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/url"
	"strings"
)

// RouterModel is one entry from inference-router-config.models.models.
type RouterModel struct {
	ID      string `json:"id"`
	BaseURL string `json:"base_url"`
}

// DesiredKey is a Bifrost openai provider key entry (subset of upstream schema).
type DesiredKey struct {
	Name           string         `json:"name"`
	Value          string         `json:"value"`
	Models         []string       `json:"models"`
	Weight         float64        `json:"weight"`
	NetworkConfig  *NetworkConfig `json:"network_config,omitempty"`
}

type NetworkConfig struct {
	BaseURL string `json:"base_url"`
}

const syncKeyPrefix = "hive-sync-"

// SyncKeyPrefix is the name prefix for keys owned by bifrost-sync (replaced on each run).
func SyncKeyPrefix() string { return syncKeyPrefix }

// GroupModelsByBaseURL groups chat model slugs by backend base_url.
func GroupModelsByBaseURL(models []RouterModel) map[string][]string {
	out := make(map[string][]string)
	for _, m := range models {
		u := strings.TrimSpace(m.BaseURL)
		if u == "" || strings.TrimSpace(m.ID) == "" {
			continue
		}
		out[u] = append(out[u], m.ID)
	}
	return out
}

// BuildDesiredKeys builds provider keys from grouped models (one key per distinct base_url).
func BuildDesiredKeys(grouped map[string][]string, dummyKeyValue string) []DesiredKey {
	if dummyKeyValue == "" {
		dummyKeyValue = "hive-unspecified"
	}
	keys := make([]DesiredKey, 0, len(grouped))
	for baseURL, models := range grouped {
		h := sha256.Sum256([]byte(baseURL))
		name := syncKeyPrefix + hex.EncodeToString(h[:6])
		keys = append(keys, DesiredKey{
			Name:   name,
			Value:  dummyKeyValue,
			Models: models,
			Weight: 1,
			NetworkConfig: &NetworkConfig{
				BaseURL: baseURL,
			},
		})
	}
	return keys
}

// HostAllowed returns true if the URL host matches suffix allowlist entries (e.g. .svc.cluster.local).
func HostAllowed(rawURL string, allowedSuffixes []string) error {
	u, err := url.Parse(rawURL)
	if err != nil {
		return fmt.Errorf("parse base_url: %w", err)
	}
	host := strings.ToLower(strings.TrimSpace(u.Hostname()))
	if host == "" {
		return fmt.Errorf("empty host in base_url")
	}
	if strings.Contains(host, "..") {
		return fmt.Errorf("suspicious host")
	}
	for _, suf := range allowedSuffixes {
		s := strings.ToLower(strings.TrimSpace(suf))
		if s == "" {
			continue
		}
		if !strings.HasPrefix(s, ".") {
			s = "." + s
		}
		if strings.HasSuffix(host, s) {
			return nil
		}
	}
	return fmt.Errorf("host %q not allowed by suffix rules", host)
}

// ValidateGroupedBaseURLs ensures every base_url in grouped keys passes HostAllowed.
func ValidateGroupedBaseURLs(grouped map[string][]string, allowedSuffixes []string) error {
	for base := range grouped {
		if err := HostAllowed(base, allowedSuffixes); err != nil {
			return fmt.Errorf("%s: %w", base, err)
		}
	}
	return nil
}
