package provision

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// Provisioner ensures an adapter's runtime is available and returns the executable path.
// If no URL is configured for the key, Provision returns ("", nil) and the caller uses the configured command as-is.
type Provisioner interface {
	Provision(ctx context.Context, adapterKey string) (execPath string, err error)
}

// DefaultProvisioner downloads adapters from HIVE_ADAPTER_<key>_URL to a cache dir and returns the path.
type DefaultProvisioner struct {
	CacheDir string
	Client   *http.Client
}

// CacheDirEnv is the env var for the provision cache directory.
const CacheDirEnv = "HIVE_PROVISION_CACHE_DIR"

// AdapterURLEnv returns the env var name for adapter download URL (HIVE_ADAPTER_<key>_URL).
func AdapterURLEnv(key string) string { return "HIVE_ADAPTER_" + key + "_URL" }

// AdapterSHA256Env returns the env var name for optional checksum (HIVE_ADAPTER_<key>_SHA256).
func AdapterSHA256Env(key string) string { return "HIVE_ADAPTER_" + key + "_SHA256" }

// GetAdapterURL returns HIVE_ADAPTER_<key>_URL.
func GetAdapterURL(key string) string {
	return os.Getenv(AdapterURLEnv(key))
}

// GetAdapterSHA256 returns HIVE_ADAPTER_<key>_SHA256 (hex-encoded).
func GetAdapterSHA256(key string) string {
	return strings.TrimSpace(os.Getenv(AdapterSHA256Env(key)))
}

// safeKey returns a filesystem-safe directory name for the adapter key (alphanumeric, -, _).
var safeKeyRe = regexp.MustCompile(`[^a-zA-Z0-9_-]`)

func safeKey(key string) string {
	return safeKeyRe.ReplaceAllString(key, "_")
}

// Provision ensures the adapter is available in cache and returns its executable path.
// If no URL is set for the key, returns ("", nil). Only HTTPS URLs are allowed.
func (p *DefaultProvisioner) Provision(ctx context.Context, adapterKey string) (execPath string, err error) {
	urlStr := strings.TrimSpace(GetAdapterURL(adapterKey))
	wantSHA := strings.TrimSpace(GetAdapterSHA256(adapterKey))
	if urlStr == "" {
		manifestURL, manifestSHA, ok, manifestErr := manifestEntryForAdapter(ctx, p.httpClient(), adapterKey)
		if manifestErr != nil {
			return "", manifestErr
		}
		if !ok {
			return "", nil
		}
		urlStr = manifestURL
		if wantSHA == "" {
			wantSHA = manifestSHA
		}
	}
	if !strings.HasPrefix(strings.ToLower(urlStr), "https://") {
		return "", fmt.Errorf("provision URL must use HTTPS: %s", urlStr)
	}
	cacheDir := p.CacheDir
	if cacheDir == "" {
		cacheDir = os.Getenv(CacheDirEnv)
	}
	if cacheDir == "" {
		home, _ := os.UserHomeDir()
		if home != "" {
			cacheDir = filepath.Join(home, ".hive-worker", "cache")
		} else {
			cacheDir = filepath.Join(os.TempDir(), "hive-worker-cache")
		}
	}
	subdir := filepath.Join(cacheDir, safeKey(adapterKey))
	if err := os.MkdirAll(subdir, 0750); err != nil {
		return "", err
	}
	// Check for existing binary: subdir/bin/<name> or subdir/<name> where name is from URL or "run"
	baseName := filepath.Base(strings.TrimSuffix(urlStr, "/"))
	if baseName == "" || baseName == "." {
		baseName = "run"
	}
	if strings.HasSuffix(strings.ToLower(baseName), ".tar.gz") || strings.HasSuffix(strings.ToLower(baseName), ".zip") {
		baseName = "bin"
	}
	candidateBin := filepath.Join(subdir, "bin", baseName)
	candidateRoot := filepath.Join(subdir, baseName)
	for _, path := range []string{candidateBin, candidateRoot, filepath.Join(subdir, "bin")} {
		if path == filepath.Join(subdir, "bin") {
			// directory: look for any executable inside
			entries, _ := os.ReadDir(path)
			for _, e := range entries {
				if !e.IsDir() {
					p := filepath.Join(path, e.Name())
					if info, err := os.Stat(p); err == nil && (info.Mode()&0111) != 0 {
						return p, nil
					}
				}
			}
			continue
		}
		if info, err := os.Stat(path); err == nil {
			if info.IsDir() {
				continue
			}
			if (info.Mode() & 0111) != 0 {
				return path, nil
			}
		}
	}
	// Download and extract
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, urlStr, nil)
	if err != nil {
		return "", err
	}
	resp, err := p.httpClient().Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("download returned %d", resp.StatusCode)
	}
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", err
	}
	if wantSHA != "" {
		sum := sha256.Sum256(body)
		got := hex.EncodeToString(sum[:])
		if !strings.EqualFold(got, wantSHA) {
			return "", fmt.Errorf("checksum mismatch: got %s", got)
		}
	}
	contentType := resp.Header.Get("Content-Type")
	if strings.Contains(strings.ToLower(contentType), "gzip") || strings.HasSuffix(strings.ToLower(urlStr), ".tar.gz") {
		if err := extractTarGZ(body, subdir); err != nil {
			return "", err
		}
		return findExecutable(subdir)
	}
	if strings.Contains(strings.ToLower(contentType), "zip") || strings.HasSuffix(strings.ToLower(urlStr), ".zip") {
		if err := extractZip(body, subdir); err != nil {
			return "", err
		}
		return findExecutable(subdir)
	}
	// Single binary
	binDir := filepath.Join(subdir, "bin")
	if err := os.MkdirAll(binDir, 0750); err != nil {
		return "", err
	}
	outPath := filepath.Join(binDir, baseName)
	if err := os.WriteFile(outPath, body, 0750); err != nil {
		return "", err
	}
	return outPath, nil
}

// findExecutable returns the path to the first executable file under dir (prefers bin/).
func findExecutable(dir string) (string, error) {
	binDir := filepath.Join(dir, "bin")
	if entries, err := os.ReadDir(binDir); err == nil {
		for _, e := range entries {
			if e.IsDir() {
				continue
			}
			p := filepath.Join(binDir, e.Name())
			if info, err := os.Stat(p); err == nil && (info.Mode()&0111) != 0 {
				return p, nil
			}
		}
	}
	return findExecutableWalk(dir)
}

var errFound = errors.New("found")

func findExecutableWalk(dir string) (string, error) {
	var first string
	err := filepath.WalkDir(dir, func(path string, d os.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		info, err := d.Info()
		if err != nil {
			return nil
		}
		if (info.Mode() & 0111) != 0 {
			first = path
			return errFound
		}
		return nil
	})
	if err != nil && err != errFound {
		return "", err
	}
	if first == "" {
		return "", fmt.Errorf("no executable found under %s", dir)
	}
	return first, nil
}

func (p *DefaultProvisioner) httpClient() *http.Client {
	if p.Client != nil {
		return p.Client
	}
	return &http.Client{}
}

// NewFromEnv returns a DefaultProvisioner with cache dir from HIVE_PROVISION_CACHE_DIR (empty = use default).
func NewFromEnv() *DefaultProvisioner {
	return &DefaultProvisioner{
		CacheDir: os.Getenv(CacheDirEnv),
	}
}
