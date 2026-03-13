package handler

import (
	"fmt"
	"net/http"
	"sync/atomic"
)

var (
	tasksTotal   atomic.Uint64
	tasksActive  atomic.Int64
	errorsTotal  atomic.Uint64
)

func Metrics(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	w.Header().Set("Content-Type", "text/plain; version=0.0.4")
	_, _ = w.Write([]byte("# HELP hive_tasks_total Total tasks received\n# TYPE hive_tasks_total counter\nhive_tasks_total "))
	_, _ = w.Write([]byte(fmt.Sprintf("%d\n", tasksTotal.Load())))
	_, _ = w.Write([]byte("# HELP hive_tasks_active Active tasks\n# TYPE hive_tasks_active gauge\nhive_tasks_active "))
	_, _ = w.Write([]byte(fmt.Sprintf("%d\n", tasksActive.Load())))
	_, _ = w.Write([]byte("# HELP hive_errors_total Total errors\n# TYPE hive_errors_total counter\nhive_errors_total "))
	_, _ = w.Write([]byte(fmt.Sprintf("%d\n", errorsTotal.Load())))
}
