// Package boardurl derives HTTP API paths from HIVE_CONTROL_PLANE_URL-style bases.
package boardurl

import (
	"net"
	"net/url"
	"strings"
)

// NormalizeControlPlaneURL trims slashes and removes a trailing /api segment (matches control-plane CLI behavior).
func NormalizeControlPlaneURL(raw string) string {
	b := strings.TrimSpace(raw)
	b = strings.TrimSuffix(b, "/")
	for strings.HasSuffix(b, "/api") {
		b = strings.TrimSuffix(b, "/api")
		b = strings.TrimSuffix(b, "/")
	}
	return b
}

// APIPrefix returns {normalized}/api for REST calls (e.g. worker-pairing under /api/worker-pairing/...).
func APIPrefix(controlPlaneURL string) string {
	base := NormalizeControlPlaneURL(controlPlaneURL)
	if base == "" {
		return ""
	}
	return base + "/api"
}

// PreferIPv4Loopback rewrites host "localhost" to "127.0.0.1" in an absolute URL.
// On Windows, dialing "localhost" often resolves to [::1] first while local dev servers
// listen on IPv4 only, which yields connection refused to :3100.
func PreferIPv4Loopback(raw string) string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return raw
	}
	u, err := url.Parse(raw)
	if err != nil {
		return raw
	}
	host := u.Hostname()
	if host == "" || !strings.EqualFold(host, "localhost") {
		return raw
	}
	port := u.Port()
	if port == "" {
		u.Host = "127.0.0.1"
	} else {
		u.Host = net.JoinHostPort("127.0.0.1", port)
	}
	return u.String()
}
