// Package version reports the hive-worker binary version (module / build info).
package version

import "runtime/debug"

// String returns the main module version from build info, or a dev placeholder.
func String() string {
	bi, ok := debug.ReadBuildInfo()
	if ok && bi.Main.Version != "" && bi.Main.Version != "(devel)" {
		return bi.Main.Version
	}
	return "0.0.0-dev"
}
