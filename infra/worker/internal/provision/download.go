package provision

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

func extractTarGZ(body []byte, destDir string) error {
	gr, err := gzip.NewReader(bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("gzip: %w", err)
	}
	defer gr.Close()
	tr := tar.NewReader(gr)
	for {
		h, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return err
		}
		name := filepath.Join(destDir, filepath.Clean(strings.TrimPrefix(h.Name, "/")))
		if rel, err := filepath.Rel(destDir, name); err != nil || strings.HasPrefix(rel, "..") {
			continue
		}
		if h.FileInfo().IsDir() {
			_ = os.MkdirAll(name, 0750)
			continue
		}
		if err := os.MkdirAll(filepath.Dir(name), 0750); err != nil {
			return err
		}
		f, err := os.OpenFile(name, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, h.FileInfo().Mode()&0755)
		if err != nil {
			return err
		}
		_, err = io.Copy(f, tr)
		f.Close()
		if err != nil {
			return err
		}
	}
	return nil
}

func extractZip(body []byte, destDir string) error {
	zr, err := zip.NewReader(bytes.NewReader(body), int64(len(body)))
	if err != nil {
		return err
	}
	for _, f := range zr.File {
		name := filepath.Join(destDir, filepath.Clean(strings.TrimPrefix(f.Name, "/")))
		if rel, err := filepath.Rel(destDir, name); err != nil || strings.HasPrefix(rel, "..") {
			continue
		}
		if f.FileInfo().IsDir() {
			_ = os.MkdirAll(name, 0750)
			continue
		}
		if err := os.MkdirAll(filepath.Dir(name), 0750); err != nil {
			return err
		}
		rc, err := f.Open()
		if err != nil {
			return err
		}
		out, err := os.OpenFile(name, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, f.Mode()&0755)
		if err != nil {
			rc.Close()
			return err
		}
		_, err = io.Copy(out, rc)
		out.Close()
		rc.Close()
		if err != nil {
			return err
		}
	}
	return nil
}
