//go:build windows

package executor

import (
	"os"
	"os/exec"
	"time"
)

func setProcAttrs(_ *exec.Cmd) {}

func terminateGracefully(proc *os.Process, grace time.Duration) {
	if proc == nil {
		return
	}
	if grace > 0 {
		time.Sleep(grace)
	}
	_ = proc.Kill()
}
