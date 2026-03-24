package main

import (
	"errors"
	"fmt"
	"log"
	"net"
	"os"
	"strconv"
	"strings"
	"syscall"
)

const defaultHTTPListenAddr = ":8080"

// httpListenPortAuto returns whether to try higher TCP ports when the preferred address is in use.
// Default: true when HIVE_WORKER_HTTP_ADDR is unset or empty (typical local dev on :8080).
// Set HIVE_WORKER_HTTP_PORT_AUTO=0 to force fail-fast on the default address.
// When HIVE_WORKER_HTTP_ADDR is set to a non-empty value, auto is off unless HIVE_WORKER_HTTP_PORT_AUTO=1.
func httpListenPortAuto() bool {
	if _, set := os.LookupEnv("HIVE_WORKER_HTTP_PORT_AUTO"); set {
		return envTruthy("HIVE_WORKER_HTTP_PORT_AUTO")
	}
	raw, addrSet := os.LookupEnv("HIVE_WORKER_HTTP_ADDR")
	if !addrSet || strings.TrimSpace(raw) == "" {
		return true
	}
	return false
}

func preferredHTTPListenAddr() string {
	if v := strings.TrimSpace(os.Getenv("HIVE_WORKER_HTTP_ADDR")); v != "" {
		return v
	}
	return defaultHTTPListenAddr
}

// splitListenAddr parses host and port for TCP listen. Forms ":8080", "0.0.0.0:8080", "[::]:8080".
func splitListenAddr(addr string) (host string, port int, err error) {
	addr = strings.TrimSpace(addr)
	if addr == "" {
		return "", 0, fmt.Errorf("empty listen address")
	}
	if strings.HasPrefix(addr, ":") {
		p, e := strconv.Atoi(strings.TrimPrefix(addr, ":"))
		if e != nil || p < 1 || p > 65535 {
			return "", 0, fmt.Errorf("invalid port in %q", addr)
		}
		return "", p, nil
	}
	h, ps, e := net.SplitHostPort(addr)
	if e != nil {
		return "", 0, e
	}
	p, conv := strconv.Atoi(ps)
	if conv != nil || p < 1 || p > 65535 {
		return "", 0, fmt.Errorf("invalid port %q", ps)
	}
	return h, p, nil
}

func joinListenAddr(host string, port int) string {
	if host == "" {
		return fmt.Sprintf(":%d", port)
	}
	return net.JoinHostPort(host, strconv.Itoa(port))
}

func isAddrInUse(err error) bool {
	if err == nil {
		return false
	}
	var op *net.OpError
	if errors.As(err, &op) && op.Err != nil {
		var errno syscall.Errno
		if errors.As(op.Err, &errno) {
			if errno == syscall.EADDRINUSE {
				return true
			}
			// Windows: WSAEADDRINUSE
			if int(errno) == 10048 {
				return true
			}
		}
	}
	msg := strings.ToLower(err.Error())
	return strings.Contains(msg, "address already in use") ||
		strings.Contains(msg, "only one usage of each socket address")
}

const maxPortFallbackAttempts = 100

// openListenTCP tries preferred; if that fails with address-in-use and portAuto is true,
// tries the same host on ports port+1 … port+maxPortFallbackAttempts-1.
func openListenTCP(preferred string, portAuto bool) (net.Listener, error) {
	ln, err := net.Listen("tcp", preferred)
	if err == nil {
		return ln, nil
	}
	if !portAuto || !isAddrInUse(err) {
		return nil, err
	}
	host, port, perr := splitListenAddr(preferred)
	if perr != nil {
		return nil, err
	}
	lastErr := err
	for offset := 1; offset < maxPortFallbackAttempts; offset++ {
		next := port + offset
		if next > 65535 {
			break
		}
		try := joinListenAddr(host, next)
		ln2, err2 := net.Listen("tcp", try)
		if err2 == nil {
			log.Printf("hive-worker: %v; listening on %s instead", lastErr, try)
			return ln2, nil
		}
		lastErr = err2
		if !isAddrInUse(err2) {
			return nil, err2
		}
	}
	return nil, err
}
