package workspacematerialize

import "testing"

func TestSanitizeDirName(t *testing.T) {
	if sanitizeDirName("feat/foo") != "feat_foo" {
		t.Fatal(sanitizeDirName("feat/foo"))
	}
}

func TestInjectHTTPSCredential(t *testing.T) {
	got := injectHTTPSCredential("https://github.com/org/repo.git", "tok")
	if got != "https://x-access-token:tok@github.com/org/repo.git" {
		t.Fatal(got)
	}
}
