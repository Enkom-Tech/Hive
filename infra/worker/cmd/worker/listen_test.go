package main

import (
	"net"
	"testing"
)

func TestSplitJoinListenAddr(t *testing.T) {
	tests := []struct {
		addr       string
		wantHost   string
		wantPort   int
		joinWant   string
		wantErr    bool
	}{
		{":8080", "", 8080, ":8080", false},
		{"127.0.0.1:9000", "127.0.0.1", 9000, "127.0.0.1:9000", false},
		{"[::1]:3000", "::1", 3000, "[::1]:3000", false},
		{"", "", 0, "", true},
		{":0", "", 0, "", true},
		{":99999", "", 0, "", true},
	}
	for _, tc := range tests {
		h, p, err := splitListenAddr(tc.addr)
		if tc.wantErr {
			if err == nil {
				t.Errorf("splitListenAddr(%q): want error", tc.addr)
			}
			continue
		}
		if err != nil {
			t.Errorf("splitListenAddr(%q): %v", tc.addr, err)
			continue
		}
		if h != tc.wantHost || p != tc.wantPort {
			t.Errorf("splitListenAddr(%q) = host %q port %d; want host %q port %d", tc.addr, h, p, tc.wantHost, tc.wantPort)
		}
		j := joinListenAddr(h, p)
		if j != tc.joinWant {
			t.Errorf("joinListenAddr(%q, %d) = %q; want %q", h, p, j, tc.joinWant)
		}
	}
}

func TestOpenListenTCPPortFallback(t *testing.T) {
	hold, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer hold.Close()
	_, portStr, err := net.SplitHostPort(hold.Addr().String())
	if err != nil {
		t.Fatalf("SplitHostPort: %v", err)
	}
	preferred := "127.0.0.1:" + portStr

	ln, err := openListenTCP(preferred, true)
	if err != nil {
		t.Fatalf("openListenTCP fallback: %v", err)
	}
	defer ln.Close()
	_, gotPort, err := net.SplitHostPort(ln.Addr().String())
	if err != nil {
		t.Fatalf("SplitHostPort result: %v", err)
	}
	if gotPort == portStr {
		t.Fatalf("expected different port than held %s, got %s", portStr, gotPort)
	}
}

func TestOpenListenTCPNoFallbackWhenDisabled(t *testing.T) {
	hold, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer hold.Close()
	_, portStr, err := net.SplitHostPort(hold.Addr().String())
	if err != nil {
		t.Fatalf("SplitHostPort: %v", err)
	}
	preferred := "127.0.0.1:" + portStr

	_, err = openListenTCP(preferred, false)
	if err == nil {
		t.Fatal("expected error when port in use and auto disabled")
	}
	if !isAddrInUse(err) {
		t.Fatalf("expected address-in-use error, got %v", err)
	}
}
