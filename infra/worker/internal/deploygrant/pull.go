package deploygrant

import (
	"context"
	"log"
	"os"
	"os/exec"
	"strings"
)

// DockerPull runs `docker pull imageRef` when runtime is docker (default).
func DockerPull(ctx context.Context, imageRef string) error {
	rt := strings.TrimSpace(strings.ToLower(os.Getenv("HIVE_CONTAINER_RUNTIME")))
	if rt == "" {
		rt = "docker"
	}
	cmd := exec.CommandContext(ctx, rt, "pull", strings.TrimSpace(imageRef))
	out, err := cmd.CombinedOutput()
	if err != nil {
		log.Printf("deploygrant: pull failed: %v %s", err, string(out))
		return err
	}
	log.Printf("deploygrant: pulled %s", imageRef)
	return nil
}
