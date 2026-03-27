package executor

import (
	"fmt"
	"os"
	"strings"

	"github.com/Enkom-Tech/hive-worker/internal/policyoverlay"
)

func mergedAllowlistCSV() string {
	base := strings.TrimSpace(os.Getenv("HIVE_CONTAINER_IMAGE_ALLOWLIST"))
	extra := strings.TrimSpace(policyoverlay.AllowlistExtraCSV())
	if extra == "" {
		return base
	}
	if base == "" {
		return extra
	}
	return base + "," + extra
}

// containerImageAllowed returns true when merged allowlist is unset/empty,
// or when the image reference has prefix matching one of the comma-separated allowlist entries.
func containerImageAllowed(image string) bool {
	raw := mergedAllowlistCSV()
	if raw == "" {
		return true
	}
	img := strings.TrimSpace(image)
	for _, p := range strings.Split(raw, ",") {
		if s := strings.TrimSpace(p); s != "" && strings.HasPrefix(img, s) {
			return true
		}
	}
	return false
}

// EnforceContainerImagePolicy returns an error when HIVE_CONTAINER_IMAGE_ENFORCE requires an allowlist
// and the image is missing, or when HIVE_CONTAINER_IMAGE_ALLOWLIST is non-empty and the image does not match.
// Used by ContainerExecutor and deploy_grant pulls so runtime and pre-pull policy stay aligned.
func EnforceContainerImagePolicy(image string) error {
	enforce := strings.TrimSpace(strings.ToLower(os.Getenv("HIVE_CONTAINER_IMAGE_ENFORCE")))
	if enforce == "1" || enforce == "true" || enforce == "yes" {
		raw := mergedAllowlistCSV()
		if raw == "" {
			return fmt.Errorf("container image denied: HIVE_CONTAINER_IMAGE_ENFORCE is set but allowlist is empty")
		}
		if !containerImageAllowed(image) {
			return fmt.Errorf("container image not allowlisted: %s", image)
		}
		return nil
	}
	if mergedAllowlistCSV() != "" && !containerImageAllowed(image) {
		return fmt.Errorf("container image not allowlisted: %s", image)
	}
	return nil
}
