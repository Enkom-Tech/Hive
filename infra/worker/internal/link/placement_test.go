package link

import (
	"os"
	"path/filepath"
	"testing"
)

func TestShouldRejectPlacement(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name     string
		expected string
		local    string
		reject   bool
	}{
		{"empty expected", "", "550e8400-e29b-41d4-a716-446655440000", false},
		{"match", "550e8400-e29b-41d4-a716-446655440000", "550e8400-e29b-41d4-a716-446655440000", false},
		{"case fold", "550E8400-E29B-41D4-A716-446655440000", "550e8400-e29b-41d4-a716-446655440000", false},
		{"mismatch", "550e8400-e29b-41d4-a716-446655440000", "650e8400-e29b-41d4-a716-446655440000", true},
		{"expected set local empty", "550e8400-e29b-41d4-a716-446655440000", "", true},
		{"whitespace", "  550e8400-e29b-41d4-a716-446655440000  ", "550e8400-e29b-41d4-a716-446655440000", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			got := shouldRejectPlacement(tc.expected, tc.local)
			if got != tc.reject {
				t.Fatalf("expected reject=%v, got %v", tc.reject, got)
			}
		})
	}
}

func TestWorkspaceDirFromContext(t *testing.T) {
	root := t.TempDir()
	t.Setenv("HIVE_WORKSPACE", root)
	inside := filepath.Join(root, "repo", "worktree-a")
	outside := filepath.Join(os.TempDir(), "other-root", "repo")

	tests := []struct {
		name string
		raw  string
		want string
	}{
		{
			name: "uses hiveWorkspace cwd inside root",
			raw:  `{"hiveWorkspace":{"cwd":"` + filepath.ToSlash(inside) + `"}}`,
			want: filepath.Clean(inside),
		},
		{
			name: "rejects outside root",
			raw:  `{"hiveWorkspace":{"cwd":"` + filepath.ToSlash(outside) + `"}}`,
			want: "",
		},
		{
			name: "empty when no hiveWorkspace",
			raw:  `{"k":"v"}`,
			want: "",
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := workspaceDirFromContext([]byte(tc.raw))
			if tc.want == "" {
				if got != "" {
					t.Fatalf("expected empty workspace dir, got %s", got)
				}
				return
			}
			if filepath.Clean(got) != tc.want {
				t.Fatalf("expected %s, got %s", tc.want, got)
			}
		})
	}
}
