// Package workspacesync optionally mirrors the local run workspace to S3 after each agent run.
// Agent CLIs write only to disk; this closes the gap when operators want objects in the bucket
// that matches the board's workspace S3 mapping (set HIVE_WORKSPACE_S3_* to the same prefix).
package workspacesync

import (
	"context"
	"io"
	"log"
	"os"
	"path/filepath"
	"strings"

	"github.com/aws/aws-sdk-go-v2/aws"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/s3"
)

const maxObjectBytes = 128 << 20 // 128 MiB — skip larger files (logs, artifacts)

func syncEnvTruthy(name string) bool {
	v := strings.TrimSpace(strings.ToLower(os.Getenv(name)))
	return v == "1" || v == "true" || v == "yes"
}

// Enabled reports whether post-run upload is configured (bucket, prefix, and sync flag).
func Enabled() bool {
	if !syncEnvTruthy("HIVE_WORKSPACE_S3_SYNC") {
		return false
	}
	if strings.TrimSpace(os.Getenv("HIVE_WORKSPACE_S3_BUCKET")) == "" {
		return false
	}
	if strings.TrimSpace(os.Getenv("HIVE_WORKSPACE_S3_PREFIX")) == "" {
		return false
	}
	return true
}

func skipDirSegment(name string) bool {
	switch name {
	case ".git", "node_modules", "__pycache__", ".venv", "venv", "dist", "build", ".next", "target", ".turbo":
		return true
	default:
		return false
	}
}

func normalizePrefix(p string) string {
	p = strings.TrimSpace(p)
	p = strings.Trim(p, "/")
	if p == "" {
		return ""
	}
	return p + "/"
}

// SyncWorkspace uploads files under localRoot to s3://bucket/prefix/<relative path>.
func SyncWorkspace(ctx context.Context, localRoot string) error {
	bucket := strings.TrimSpace(os.Getenv("HIVE_WORKSPACE_S3_BUCKET"))
	prefix := normalizePrefix(os.Getenv("HIVE_WORKSPACE_S3_PREFIX"))
	region := strings.TrimSpace(os.Getenv("AWS_REGION"))
	if region == "" {
		region = strings.TrimSpace(os.Getenv("AWS_DEFAULT_REGION"))
	}
	if region == "" {
		region = "us-east-1"
	}

	absRoot, err := filepath.Abs(localRoot)
	if err != nil {
		return err
	}
	st, err := os.Stat(absRoot)
	if err != nil {
		return err
	}
	if !st.IsDir() {
		return nil
	}

	cfg, err := awsconfig.LoadDefaultConfig(ctx, awsconfig.WithRegion(region))
	if err != nil {
		return err
	}
	client := s3.NewFromConfig(cfg)

	var uploaded int
	err = filepath.WalkDir(absRoot, func(path string, d os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if d.IsDir() {
			if path != absRoot && skipDirSegment(filepath.Base(path)) {
				return filepath.SkipDir
			}
			return nil
		}
		rel, err := filepath.Rel(absRoot, path)
		if err != nil {
			return err
		}
		rel = filepath.ToSlash(rel)
		if rel == "." {
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		if info.Size() > maxObjectBytes {
			log.Printf("workspacesync: skip large file %s (%d bytes)", rel, info.Size())
			return nil
		}
		key := prefix + rel
		f, err := os.Open(path)
		if err != nil {
			return err
		}
		uploadErr := putObject(ctx, client, bucket, key, f, info.Size())
		_ = f.Close()
		if uploadErr != nil {
			return uploadErr
		}
		uploaded++
		return nil
	})
	if err != nil {
		return err
	}
	if uploaded > 0 {
		log.Printf("workspacesync: uploaded %d objects to s3://%s/%s", uploaded, bucket, prefix)
	}
	return nil
}

func putObject(ctx context.Context, client *s3.Client, bucket, key string, body io.Reader, size int64) error {
	input := &s3.PutObjectInput{
		Bucket: aws.String(bucket),
		Key:    aws.String(key),
		Body:   body,
	}
	if size >= 0 {
		input.ContentLength = aws.Int64(size)
	}
	_, err := client.PutObject(ctx, input)
	return err
}
