package link

import (
	"os"
	"path/filepath"
	"testing"
)

func TestPersistWorkerApiToken_roundTrip(t *testing.T) {
	dir := t.TempDir()
	tok := "test.jwt.token.value"
	if err := PersistWorkerApiToken(dir, tok); err != nil {
		t.Fatal(err)
	}
	got := ReadWorkerApiToken(dir)
	if got != tok {
		t.Fatalf("ReadWorkerApiToken: got %q want %q", got, tok)
	}
}

func TestReadWorkerApiToken_emptyStateDirUsesDefaultPath(t *testing.T) {
	// When state dir is empty, path is under UserConfigDir — only verify empty read does not panic.
	_ = ReadWorkerApiToken("")
}

func TestPersistWorkerApiToken_emptyTokenNoOp(t *testing.T) {
	dir := t.TempDir()
	if err := PersistWorkerApiToken(dir, "   "); err != nil {
		t.Fatal(err)
	}
	p, err := workerApiTokenFilePath(dir)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(p); err == nil {
		t.Fatal("expected no file for empty token")
	}
}

func TestWorkerApiTokenFilePath_explicitDir(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "nested")
	p, err := workerApiTokenFilePath(dir)
	if err != nil {
		t.Fatal(err)
	}
	if filepath.Base(p) != workerApiTokenFileName {
		t.Fatalf("basename: %s", p)
	}
}
