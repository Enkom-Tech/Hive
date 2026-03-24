package instanceid

import (
	"os"
	"path/filepath"
	"testing"
)

func TestEnsure_idempotent(t *testing.T) {
	dir := t.TempDir()
	a, err := Ensure(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(a) != 36 {
		t.Fatalf("expected uuid length 36, got %d", len(a))
	}
	b, err := Ensure(dir)
	if err != nil {
		t.Fatal(err)
	}
	if a != b {
		t.Fatalf("second call should return same id: %q vs %q", a, b)
	}
	data, err := os.ReadFile(filepath.Join(dir, "instance-id"))
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != a+"\n" && string(data) != a {
		t.Fatalf("file content mismatch")
	}
}
