package link

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
)

// RunUsageFileName is written by agent tooling in the run workspace to report token usage and cost.
const RunUsageFileName = ".hive-run-usage.json"

// RunUsageSidecar is the JSON shape tools may emit for the worker to forward on the final status message.
type RunUsageSidecar struct {
	Usage    *RunUsageBreakdown `json:"usage,omitempty"`
	CostUsd  float64            `json:"costUsd,omitempty"`
	Provider string             `json:"provider,omitempty"`
	Model    string             `json:"model,omitempty"`
}

// RunUsageBreakdown matches control-plane sanitizeWorkerStatusPayload usage object.
type RunUsageBreakdown struct {
	InputTokens       int `json:"inputTokens"`
	OutputTokens      int `json:"outputTokens"`
	CachedInputTokens int `json:"cachedInputTokens"`
}

// ReadRunUsageSidecar reads RunUsageFileName from workspaceDir when present.
func ReadRunUsageSidecar(workspaceDir string) *RunUsageSidecar {
	dir := strings.TrimSpace(workspaceDir)
	if dir == "" {
		return nil
	}
	p := filepath.Join(dir, RunUsageFileName)
	raw, err := os.ReadFile(p) // #nosec G304 -- path is under operator workspace
	if err != nil || len(raw) == 0 {
		return nil
	}
	var s RunUsageSidecar
	if json.Unmarshal(raw, &s) != nil {
		return nil
	}
	if s.Usage == nil && s.CostUsd == 0 && s.Provider == "" && s.Model == "" {
		return nil
	}
	return &s
}

// MergeRunUsageIntoStatus adds usage, costUsd, provider, model keys to a status payload when sidecar is non-nil.
func MergeRunUsageIntoStatus(payload map[string]interface{}, side *RunUsageSidecar, fallbackModel string) {
	if side == nil {
		if m := strings.TrimSpace(fallbackModel); m != "" {
			payload["model"] = m
		}
		return
	}
	if side.Usage != nil {
		payload["usage"] = map[string]interface{}{
			"inputTokens":       side.Usage.InputTokens,
			"outputTokens":      side.Usage.OutputTokens,
			"cachedInputTokens": side.Usage.CachedInputTokens,
		}
	}
	if side.CostUsd > 0 {
		payload["costUsd"] = side.CostUsd
	}
	if strings.TrimSpace(side.Provider) != "" {
		payload["provider"] = strings.TrimSpace(side.Provider)
	}
	model := strings.TrimSpace(side.Model)
	if model == "" {
		model = strings.TrimSpace(fallbackModel)
	}
	if model != "" {
		payload["model"] = model
	} else if strings.TrimSpace(fallbackModel) != "" {
		payload["model"] = strings.TrimSpace(fallbackModel)
	}
}
