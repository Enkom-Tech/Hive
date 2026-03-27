package deploygrant

import (
	"regexp"
	"strings"
)

var digestPinnedRe = regexp.MustCompile(`@sha256:[a-fA-F0-9]{64}$`)

// DigestPinned reports whether imageRef ends with an OCI sha256 digest (immutable pin).
func DigestPinned(imageRef string) bool {
	s := strings.TrimSpace(imageRef)
	return s != "" && digestPinnedRe.MatchString(s)
}
