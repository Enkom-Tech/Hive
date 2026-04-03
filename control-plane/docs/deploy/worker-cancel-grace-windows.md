# Worker cancel grace on Windows

When `HIVE_CANCEL_GRACE_SECONDS` is set, the Linux/macOS worker sends **SIGTERM** to the tool process group, waits, then **SIGKILL** if the process is still running.

On **Windows**, the worker starts the tool with **`CREATE_NEW_PROCESS_GROUP`**, then on cancel calls **`GenerateConsoleCtrlEvent(CTRL_BREAK_EVENT, processGroupId)`** (targeting the child PID as group id), waits the grace period, then **`TerminateProcess`** via `Process.Kill()`. Processes **without a console** (services, some GUIs) may ignore the break event; behavior remains **best-effort** compared to Unix signal semantics.

## Recommendations

- Run **hive-worker** on **Linux** (VPS, WSL2-side worker, or container) when you rely on cooperative cancel during heartbeat stops.
- If you must run on native Windows, treat `HIVE_CANCEL_GRACE_SECONDS` as a **delay before hard kill**, not a signal-based graceful phase.

See [DRONE-SPEC.md](../../doc/DRONE-SPEC.md) §10 (Stop/cancel row) for the normative behavior matrix.
