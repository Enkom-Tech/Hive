package boardurl

import "testing"

func TestNormalizeControlPlaneURL(t *testing.T) {
	tests := []struct {
		in, want string
	}{
		{"", ""},
		{"https://board.example/", "https://board.example"},
		{"https://board.example/api", "https://board.example"},
		{"https://board.example/api/", "https://board.example"},
		{"http://localhost:3100/api", "http://localhost:3100"},
	}
	for _, tc := range tests {
		if g := NormalizeControlPlaneURL(tc.in); g != tc.want {
			t.Errorf("NormalizeControlPlaneURL(%q) = %q want %q", tc.in, g, tc.want)
		}
	}
}

func TestAPIPrefix(t *testing.T) {
	if g := APIPrefix("https://x.test"); g != "https://x.test/api" {
		t.Fatalf("APIPrefix = %q", g)
	}
	if APIPrefix("") != "" {
		t.Fatal("empty in should yield empty")
	}
}

func TestPreferIPv4Loopback(t *testing.T) {
	tests := []struct {
		in, want string
	}{
		{"", ""},
		{"http://localhost:3100", "http://127.0.0.1:3100"},
		{"http://LOCALHOST:3100/foo", "http://127.0.0.1:3100/foo"},
		{"ws://localhost:3100/api/workers/link", "ws://127.0.0.1:3100/api/workers/link"},
		{"https://board.example", "https://board.example"},
		{"http://127.0.0.1:3100", "http://127.0.0.1:3100"},
		{"http://[::1]:3100/x", "http://[::1]:3100/x"},
	}
	for _, tc := range tests {
		if g := PreferIPv4Loopback(tc.in); g != tc.want {
			t.Errorf("PreferIPv4Loopback(%q) = %q want %q", tc.in, g, tc.want)
		}
	}
}
