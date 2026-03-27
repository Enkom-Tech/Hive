package handler

import (
	"fmt"
	"io"
	"sync/atomic"
)

// Worker MCP / indexer observability (Prometheus text without client lib).
var (
	indexerCallsCodeOK    atomic.Uint64
	indexerCallsCodeError atomic.Uint64
	indexerCallsDocsOK    atomic.Uint64
	indexerCallsDocsError atomic.Uint64
	indexerMsSumCode      atomic.Uint64
	indexerMsCountCode    atomic.Uint64
	indexerMsSumDocs      atomic.Uint64
	indexerMsCountDocs    atomic.Uint64
	indexerCircuitCode    atomic.Uint32
	indexerCircuitDocs    atomic.Uint32
	wasmSkillOK           atomic.Uint64
	wasmSkillError        atomic.Uint64
	wasmMsSum             atomic.Uint64
	wasmMsCount           atomic.Uint64
)

// RecordIndexerGatewayCall increments call counters and duration aggregates for code/docs gateways.
func RecordIndexerGatewayCall(gatewayName string, ok bool, durationMs int64) {
	switch gatewayName {
	case "code":
		if ok {
			indexerCallsCodeOK.Add(1)
		} else {
			indexerCallsCodeError.Add(1)
		}
		if durationMs >= 0 {
			indexerMsSumCode.Add(uint64(durationMs))
			indexerMsCountCode.Add(1)
		}
	case "docs":
		if ok {
			indexerCallsDocsOK.Add(1)
		} else {
			indexerCallsDocsError.Add(1)
		}
		if durationMs >= 0 {
			indexerMsSumDocs.Add(uint64(durationMs))
			indexerMsCountDocs.Add(1)
		}
	default:
		return
	}
}

// SetIndexerCircuitOpen sets the gauge for indexer circuit breaker (1=open).
func SetIndexerCircuitOpen(gatewayName string, open bool) {
	v := uint32(0)
	if open {
		v = 1
	}
	switch gatewayName {
	case "code":
		indexerCircuitCode.Store(v)
	case "docs":
		indexerCircuitDocs.Store(v)
	}
}

// RecordWasmSkillCall records WASM skill invocation outcome and latency.
func RecordWasmSkillCall(ok bool, durationMs int64) {
	if ok {
		wasmSkillOK.Add(1)
	} else {
		wasmSkillError.Add(1)
	}
	if durationMs >= 0 {
		wasmMsSum.Add(uint64(durationMs))
		wasmMsCount.Add(1)
	}
}

// WriteWorkerMCPMetrics appends hive_mcp_* and hive_wasm_* lines to w.
func WriteWorkerMCPMetrics(w io.Writer) {
	_, _ = fmt.Fprintf(w, "# HELP hive_mcp_indexer_calls_total MCP indexer gateway JSON-RPC calls\n# TYPE hive_mcp_indexer_calls_total counter\n")
	_, _ = fmt.Fprintf(w, "hive_mcp_indexer_calls_total{gateway=\"code\",result=\"ok\"} %d\n", indexerCallsCodeOK.Load())
	_, _ = fmt.Fprintf(w, "hive_mcp_indexer_calls_total{gateway=\"code\",result=\"error\"} %d\n", indexerCallsCodeError.Load())
	_, _ = fmt.Fprintf(w, "hive_mcp_indexer_calls_total{gateway=\"docs\",result=\"ok\"} %d\n", indexerCallsDocsOK.Load())
	_, _ = fmt.Fprintf(w, "hive_mcp_indexer_calls_total{gateway=\"docs\",result=\"error\"} %d\n", indexerCallsDocsError.Load())
	_, _ = fmt.Fprintf(w, "# HELP hive_mcp_indexer_request_duration_ms_sum Sum of indexer HTTP round-trip milliseconds\n# TYPE hive_mcp_indexer_request_duration_ms_sum counter\n")
	_, _ = fmt.Fprintf(w, "hive_mcp_indexer_request_duration_ms_sum{gateway=\"code\"} %d\n", indexerMsSumCode.Load())
	_, _ = fmt.Fprintf(w, "hive_mcp_indexer_request_duration_ms_sum{gateway=\"docs\"} %d\n", indexerMsSumDocs.Load())
	_, _ = fmt.Fprintf(w, "# HELP hive_mcp_indexer_request_duration_ms_count Indexer HTTP calls with recorded duration\n# TYPE hive_mcp_indexer_request_duration_ms_count counter\n")
	_, _ = fmt.Fprintf(w, "hive_mcp_indexer_request_duration_ms_count{gateway=\"code\"} %d\n", indexerMsCountCode.Load())
	_, _ = fmt.Fprintf(w, "hive_mcp_indexer_request_duration_ms_count{gateway=\"docs\"} %d\n", indexerMsCountDocs.Load())
	_, _ = fmt.Fprintf(w, "# HELP hive_mcp_indexer_circuit_open Circuit breaker open (1) or closed (0)\n# TYPE hive_mcp_indexer_circuit_open gauge\n")
	_, _ = fmt.Fprintf(w, "hive_mcp_indexer_circuit_open{gateway=\"code\"} %d\n", indexerCircuitCode.Load())
	_, _ = fmt.Fprintf(w, "hive_mcp_indexer_circuit_open{gateway=\"docs\"} %d\n", indexerCircuitDocs.Load())
	_, _ = fmt.Fprintf(w, "# HELP hive_wasm_skill_calls_total WASM skill invocations from hive-worker mcp\n# TYPE hive_wasm_skill_calls_total counter\n")
	_, _ = fmt.Fprintf(w, "hive_wasm_skill_calls_total{result=\"ok\"} %d\n", wasmSkillOK.Load())
	_, _ = fmt.Fprintf(w, "hive_wasm_skill_calls_total{result=\"error\"} %d\n", wasmSkillError.Load())
	_, _ = fmt.Fprintf(w, "# HELP hive_wasm_skill_duration_ms_sum Sum WASM skill wall milliseconds\n# TYPE hive_wasm_skill_duration_ms_sum counter\n")
	_, _ = fmt.Fprintf(w, "hive_wasm_skill_duration_ms_sum %d\n", wasmMsSum.Load())
	_, _ = fmt.Fprintf(w, "# HELP hive_wasm_skill_duration_ms_count WASM invocations with recorded duration\n# TYPE hive_wasm_skill_duration_ms_count counter\n")
	_, _ = fmt.Fprintf(w, "hive_wasm_skill_duration_ms_count %d\n", wasmMsCount.Load())
}
