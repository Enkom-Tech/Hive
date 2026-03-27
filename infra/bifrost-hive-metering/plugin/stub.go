//go:build !linux

// Stub so `go test ./...` succeeds on non-Linux builders; the real plugin is plugin_linux.go.
package main

func init() {}
