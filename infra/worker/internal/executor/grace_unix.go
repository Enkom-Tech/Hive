//go:build !windows

package executor

import (
	"os"
	"os/exec"
	"syscall"
	"time"
)

func setProcAttrs(cmd *exec.Cmd) {
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	cmd.SysProcAttr.Setpgid = true
}

// terminateGracefully sends SIGTERM to the child's process group, waits grace, then SIGKILL.
func terminateGracefully(proc *os.Process, grace time.Duration) {
	if proc == nil {
		return
	}
	pid := proc.Pid
	if pid <= 0 {
		_ = proc.Kill()
		return
	}
	_ = syscall.Kill(-pid, syscall.SIGTERM)
	if grace <= 0 {
		_ = syscall.Kill(-pid, syscall.SIGKILL)
		return
	}
	time.Sleep(grace)
	_ = syscall.Kill(-pid, syscall.SIGKILL)
}
