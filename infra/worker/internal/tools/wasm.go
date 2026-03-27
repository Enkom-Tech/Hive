package tools

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/Enkom-Tech/hive-worker/internal/handler"
	"github.com/tetratelabs/wazero"
	"github.com/tetratelabs/wazero/imports/wasi_snapshot_preview1"
)

// WasmSkill is a WASI wasm module plus MCP tool metadata from a sidecar JSON file.
type WasmSkill struct {
	Name        string          `json:"name"`
	Description string          `json:"description"`
	InputSchema json.RawMessage `json:"inputSchema"`
	WasmPath    string          `json:"-"`
}

var (
	wasmCompileOnce   sync.Once
	wasmCompileShared wazero.CompilationCache
)

func wasmCompilationCache() wazero.CompilationCache {
	wasmCompileOnce.Do(func() {
		wasmCompileShared = wazero.NewCompilationCache()
	})
	return wasmCompileShared
}

// Trust: only operator-controlled WASM under HIVE_PROVISION_CACHE_DIR/skills/ should be loaded.
// Malicious or buggy modules can still burn CPU until timeout; keep skills/ locked down and signed manifests when possible.

func wasmSkillTimeout() time.Duration {
	ms := int64(30000)
	if s := strings.TrimSpace(os.Getenv("HIVE_WASM_SKILL_TIMEOUT_MS")); s != "" {
		if v, err := strconv.ParseInt(s, 10, 64); err == nil && v > 0 && v <= 600000 {
			ms = v
		}
	}
	return time.Duration(ms) * time.Millisecond
}

func wasmMemoryLimitPages() uint32 {
	const defaultPages = uint32(256) // 16 MiB cap on wasm memory growth
	if s := strings.TrimSpace(os.Getenv("HIVE_WASM_MEMORY_LIMIT_PAGES")); s != "" {
		if v, err := strconv.ParseUint(s, 10, 32); err == nil && v > 0 && v <= 4096 {
			return uint32(v)
		}
	}
	return defaultPages
}

func wasmMaxStdoutBytes() int {
	const defaultMax = 2 << 20
	if s := strings.TrimSpace(os.Getenv("HIVE_WASM_MAX_STDOUT_BYTES")); s != "" {
		if v, err := strconv.Atoi(s); err == nil && v > 1024 && v <= 16<<20 {
			return v
		}
	}
	return defaultMax
}

type cappedStdout struct {
	buf   *strings.Builder
	limit int
	n     int
}

func (c *cappedStdout) Write(p []byte) (int, error) {
	avail := c.limit - c.n
	if avail <= 0 {
		return 0, fmt.Errorf("wasm stdout exceeded limit (%d bytes)", c.limit)
	}
	if len(p) > avail {
		_, _ = c.buf.Write(p[:avail])
		c.n += avail
		return 0, fmt.Errorf("wasm stdout exceeded limit (%d bytes)", c.limit)
	}
	c.n += len(p)
	return c.buf.Write(p)
}

// LoadWasmSkills scans dir/skills for *.wasm files; each must have a sibling {base}.schema.json.
func LoadWasmSkills(cacheRoot string) ([]WasmSkill, error) {
	root := strings.TrimSpace(cacheRoot)
	if root == "" {
		return nil, nil
	}
	skillsDir := filepath.Join(root, "skills")
	entries, err := os.ReadDir(skillsDir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	var out []WasmSkill
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		name := e.Name()
		if !strings.HasSuffix(strings.ToLower(name), ".wasm") {
			continue
		}
		base := strings.TrimSuffix(name, filepath.Ext(name))
		schemaPath := filepath.Join(skillsDir, base+".schema.json")
		raw, err := os.ReadFile(schemaPath)
		if err != nil {
			continue
		}
		var meta WasmSkill
		if json.Unmarshal(raw, &meta) != nil || strings.TrimSpace(meta.Name) == "" {
			continue
		}
		meta.WasmPath = filepath.Join(skillsDir, name)
		out = append(out, meta)
	}
	return out, nil
}

// RunWasmSkill executes a WASI command module: JSON arguments on stdin, stdout is returned (capped).
func RunWasmSkill(ctx context.Context, wasmPath string, argsJSON []byte) ([]byte, error) {
	start := time.Now()
	runCtx, cancel := context.WithTimeout(ctx, wasmSkillTimeout())
	defer cancel()

	wasmBytes, err := os.ReadFile(wasmPath)
	if err != nil {
		handler.RecordWasmSkillCall(false, time.Since(start).Milliseconds())
		return nil, err
	}
	if len(wasmBytes) == 0 {
		handler.RecordWasmSkillCall(false, time.Since(start).Milliseconds())
		return nil, fmt.Errorf("empty wasm: %s", wasmPath)
	}

	rConfig := wazero.NewRuntimeConfig().
		WithMemoryLimitPages(wasmMemoryLimitPages()).
		WithCloseOnContextDone(true).
		WithCompilationCache(wasmCompilationCache())

	r := wazero.NewRuntimeWithConfig(runCtx, rConfig)
	defer func() {
		if cerr := r.Close(context.Background()); cerr != nil {
			log.Printf("hive-mcp wasm: runtime close: %v", cerr)
		}
	}()

	if _, err := wasi_snapshot_preview1.Instantiate(runCtx, r); err != nil {
		handler.RecordWasmSkillCall(false, time.Since(start).Milliseconds())
		return nil, err
	}
	compiled, err := r.CompileModule(runCtx, wasmBytes)
	if err != nil {
		handler.RecordWasmSkillCall(false, time.Since(start).Milliseconds())
		return nil, err
	}
	var stdout strings.Builder
	capOut := &cappedStdout{buf: &stdout, limit: wasmMaxStdoutBytes()}
	cfg := wazero.NewModuleConfig().
		WithStdin(bytes.NewReader(argsJSON)).
		WithStdout(capOut).
		WithArgs(filepath.Base(wasmPath), "run")
	_, err = r.InstantiateModule(runCtx, compiled, cfg)
	dur := time.Since(start)
	durMs := dur.Milliseconds()
	if err != nil {
		log.Printf("hive-mcp wasm: path=%s duration_ms=%d err=%v", filepath.Base(wasmPath), durMs, err)
		handler.RecordWasmSkillCall(false, durMs)
		return nil, err
	}
	log.Printf("hive-mcp wasm: path=%s duration_ms=%d ok", filepath.Base(wasmPath), durMs)
	handler.RecordWasmSkillCall(true, durMs)
	return []byte(stdout.String()), nil
}
