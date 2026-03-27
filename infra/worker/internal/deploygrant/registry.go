package deploygrant

import (
	"os"
	"strings"
)

// RegistryAllowed returns true if imageRef starts with one of HIVE_DEPLOY_ALLOWED_REGISTRIES entries (comma-separated).
func RegistryAllowed(imageRef string) bool {
	raw := strings.TrimSpace(os.Getenv("HIVE_DEPLOY_ALLOWED_REGISTRIES"))
	if raw == "" {
		return false
	}
	ref := strings.TrimSpace(imageRef)
	for _, p := range strings.Split(raw, ",") {
		if s := strings.TrimSpace(p); s != "" && strings.HasPrefix(ref, s) {
			return true
		}
	}
	return false
}
