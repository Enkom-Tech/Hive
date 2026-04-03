//go:build windows

package executor

import (
	"os"
	"os/exec"
	"syscall"
	"time"

	"golang.org/x/sys/windows"
)

// setProcAttrs puts the child in its own process group so GenerateConsoleCtrlEvent can target it.
func setProcAttrs(cmd *exec.Cmd) {
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	cmd.SysProcAttr.CreationFlags |= syscall.CREATE_NEW_PROCESS_GROUP
}

// terminateGracefully sends CTRL_BREAK to the child's process group (best-effort for console tools),
// waits up to grace, then TerminateProcess. Fails open to sleep+Kill if the signal API errors.
func terminateGracefully(proc *os.Process, grace time.Duration) {
	if proc == nil {
		return
	}
	pid := proc.Pid
	if pid <= 0 {
		return
	}
	_ = windows.GenerateConsoleCtrlEvent(windows.CTRL_BREAK_EVENT, uint32(pid))
	if grace > 0 {
		time.Sleep(grace)
	}
	_ = proc.Kill()
}
