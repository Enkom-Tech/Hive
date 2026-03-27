package tools

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestServeMCP_initializeAndToolsList(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer srv.Close()

	cp := &CPClient{
		APIBase: strings.TrimSuffix(srv.URL, "/") + "/api",
		JWT:     "jwt",
		AgentID: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
		HTTP:    srv.Client(),
	}

	var inBuf bytes.Buffer
	var outBuf bytes.Buffer
	inBuf.WriteString(`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}` + "\n")
	inBuf.WriteString(`{"jsonrpc":"2.0","id":2,"method":"tools/list"}` + "\n")

	err := ServeMCP(context.Background(), &inBuf, &outBuf, ServeConfig{CP: cp})
	if err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimSpace(outBuf.String()), "\n")
	if len(lines) < 2 {
		t.Fatalf("expected 2+ lines, got %q", outBuf.String())
	}
	var initOk rpcResponseOK
	if err := json.Unmarshal([]byte(lines[0]), &initOk); err != nil {
		t.Fatal(err)
	}
	if initOk.Result == nil {
		t.Fatal("missing initialize result")
	}
	var listOk rpcResponseOK
	if err := json.Unmarshal([]byte(lines[1]), &listOk); err != nil {
		t.Fatal(err)
	}
	m, ok := listOk.Result.(map[string]any)
	if !ok {
		t.Fatalf("result type %T", listOk.Result)
	}
	tools, _ := m["tools"].([]any)
	if len(tools) < 4 {
		t.Fatalf("expected at least 4 builtin tools, got %d", len(tools))
	}
}

func TestServeMCP_parallelCostReport(t *testing.T) {
	delay := 80 * time.Millisecond
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(delay)
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer srv.Close()

	cp := &CPClient{
		APIBase: strings.TrimSuffix(srv.URL, "/") + "/api",
		JWT:     "jwt",
		AgentID: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
		HTTP:    srv.Client(),
	}

	body := `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"cost.report","arguments":{"provider":"x","model":"m","costCents":1}}}` + "\n" +
		`{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"cost.report","arguments":{"provider":"x","model":"m","costCents":1}}}` + "\n"
	var inBuf bytes.Buffer
	var outBuf bytes.Buffer
	inBuf.WriteString(body)

	start := time.Now()
	err := ServeMCP(context.Background(), &inBuf, &outBuf, ServeConfig{CP: cp, MaxConcurrent: 2})
	elapsed := time.Since(start)
	if err != nil {
		t.Fatal(err)
	}
	if elapsed >= delay+time.Millisecond*70 {
		t.Fatalf("expected overlapping cost.report calls with MaxConcurrent=2, elapsed=%v", elapsed)
	}

	inBuf.Reset()
	outBuf.Reset()
	inBuf.WriteString(body)
	start = time.Now()
	err = ServeMCP(context.Background(), &inBuf, &outBuf, ServeConfig{CP: cp, MaxConcurrent: 1})
	elapsed = time.Since(start)
	if err != nil {
		t.Fatal(err)
	}
	if elapsed < delay+time.Millisecond*50 {
		t.Fatalf("expected sequential cost.report with MaxConcurrent=1, elapsed=%v", elapsed)
	}
}
