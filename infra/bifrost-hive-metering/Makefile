# Bifrost loads this as a Go plugin (-buildmode=plugin). Build on Linux with the same Go
# toolchain version Bifrost was compiled with. See ../model-gateway/BIFROST-RUNBOOK.md § Metering plugin.
.PHONY: plugin
plugin:
	CGO_ENABLED=1 go build -buildmode=plugin -trimpath -o hive_metering.so ./plugin

.PHONY: test
test:
	go test ./...
