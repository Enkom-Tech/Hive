// Command model-gateway is a minimal OpenAI-compatible HTTP router (stdlib only).
// It replaces the Python service in infra/model-gateway for a smaller runtime attack surface.
package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const defaultAddr = ":8080"

type modelEntry struct {
	ID         string `json:"id"`
	BaseURL    string `json:"base_url"`
	APIKeyEnv  string `json:"api_key_env,omitempty"`
	BaseURLAlt string `json:"baseUrl,omitempty"`
}

type modelsFile struct {
	Models []modelEntry `json:"models"`
}

func loadModels(path string) ([]modelEntry, error) {
	raw := os.Getenv("MODELS_JSON")
	if raw != "" {
		var mf modelsFile
		if err := json.Unmarshal([]byte(raw), &mf); err != nil {
			return nil, err
		}
		if len(mf.Models) == 0 {
			return nil, nil
		}
		return mf.Models, nil
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var mf modelsFile
	if err := json.Unmarshal(b, &mf); err != nil {
		return nil, err
	}
	if len(mf.Models) > 0 {
		return mf.Models, nil
	}
	var arr []modelEntry
	if err := json.Unmarshal(b, &arr); err != nil {
		return nil, err
	}
	return arr, nil
}

func baseOf(m modelEntry) string {
	s := strings.TrimSpace(m.BaseURL)
	if s == "" {
		s = strings.TrimSpace(m.BaseURLAlt)
	}
	return strings.TrimRight(s, "/")
}

func findBackend(models []modelEntry, modelID string) (baseURL, apiKey string) {
	for _, m := range models {
		if m.ID == modelID {
			b := baseOf(m)
			if b == "" {
				return "", ""
			}
			if m.APIKeyEnv != "" {
				apiKey = strings.TrimSpace(os.Getenv(m.APIKeyEnv))
			}
			return b, apiKey
		}
	}
	return "", ""
}

type virtualKeyEntry struct {
	SHA256    string `json:"sha256"`
	CompanyID string `json:"company_id"`
}

type virtualKeysFile struct {
	Keys []virtualKeyEntry `json:"keys"`
}

func loadVirtualKeyMap(path string) map[string]string {
	out := make(map[string]string)
	raw := strings.TrimSpace(os.Getenv("VIRTUAL_KEYS_JSON"))
	if raw != "" {
		var vf virtualKeysFile
		if err := json.Unmarshal([]byte(raw), &vf); err != nil {
			log.Printf("model-gateway: virtual keys JSON: %v", err)
			return out
		}
		for _, k := range vf.Keys {
			h := strings.ToLower(strings.TrimSpace(k.SHA256))
			if h != "" && k.CompanyID != "" {
				out[h] = strings.TrimSpace(k.CompanyID)
			}
		}
		return out
	}
	if strings.TrimSpace(path) == "" {
		return out
	}
	b, err := os.ReadFile(path)
	if err != nil {
		log.Printf("model-gateway: virtual keys file: %v", err)
		return out
	}
	var vf virtualKeysFile
	if err := json.Unmarshal(b, &vf); err != nil {
		log.Printf("model-gateway: virtual keys parse: %v", err)
		return out
	}
	for _, k := range vf.Keys {
		h := strings.ToLower(strings.TrimSpace(k.SHA256))
		if h != "" && k.CompanyID != "" {
			out[h] = strings.TrimSpace(k.CompanyID)
		}
	}
	return out
}

func bearerToken(h http.Header) string {
	raw := strings.TrimSpace(h.Get("Authorization"))
	if len(raw) < 8 || strings.ToLower(raw[:7]) != "bearer " {
		return ""
	}
	return strings.TrimSpace(raw[7:])
}

func sha256Hex(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:])
}

type openAIUsage struct {
	PromptTokens     int `json:"prompt_tokens"`
	CompletionTokens int `json:"completion_tokens"`
}

func postMeteringAsync(url, bearer, companyID, modelID string, inTok, outTok int) {
	if url == "" || companyID == "" {
		return
	}
	body := map[string]any{
		"companyId":     companyID,
		"source":        "gateway_aggregate",
		"agentId":       nil,
		"provider":      "model_gateway",
		"model":         modelID,
		"inputTokens":   inTok,
		"outputTokens":  outTok,
		"costCents":     0,
		"occurredAt":    time.Now().UTC().Format(time.RFC3339Nano),
	}
	raw, err := json.Marshal(body)
	if err != nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(raw))
	if err != nil {
		return
	}
	req.Header.Set("Content-Type", "application/json")
	if strings.TrimSpace(bearer) != "" {
		req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(bearer))
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		log.Printf("model-gateway: metering post: %v", err)
		return
	}
	_ = resp.Body.Close()
}

func main() {
	configPath := os.Getenv("CONFIG_PATH")
	if configPath == "" {
		configPath = "/etc/model-gateway/models.json"
	}
	addr := strings.TrimSpace(os.Getenv("LISTEN_ADDR"))
	if addr == "" {
		addr = defaultAddr
	}
	vkPath := strings.TrimSpace(os.Getenv("VIRTUAL_KEYS_PATH"))
	meterURL := strings.TrimSpace(os.Getenv("METERING_URL"))
	meterBearer := strings.TrimSpace(os.Getenv("METERING_BEARER"))

	models, err := loadModels(configPath)
	if err != nil {
		log.Printf("model-gateway: warning loading config: %v", err)
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/health", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"ok"}`))
	})

	mux.HandleFunc("/v1/models", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		list, err := loadModels(configPath)
		if err != nil {
			list = models
		}
		type item struct {
			ID      string `json:"id"`
			Object  string `json:"object"`
			Created int    `json:"created"`
		}
		out := make([]item, 0, len(list))
		for _, m := range list {
			out = append(out, item{ID: m.ID, Object: "model", Created: 0})
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"object": "list",
			"data":   out,
		})
	})

	mux.HandleFunc("/v1/", func(w http.ResponseWriter, r *http.Request) {
		sub := strings.TrimPrefix(r.URL.Path, "/v1/")
		if sub == "" || sub == "/" {
			http.NotFound(w, r)
			return
		}
		body, err := io.ReadAll(io.LimitReader(r.Body, 32<<20))
		if err != nil {
			http.Error(w, "bad body", http.StatusBadRequest)
			return
		}
		_ = r.Body.Close()

		var payload map[string]any
		_ = json.Unmarshal(body, &payload)
		modelID, _ := payload["model"].(string)
		if modelID == "" {
			modelID = r.URL.Query().Get("model")
		}
		if modelID == "" {
			http.Error(w, `{"detail":"Missing model"}`, http.StatusBadRequest)
			return
		}

		list, lerr := loadModels(configPath)
		if lerr != nil {
			list = models
		}
		base, key := findBackend(list, modelID)
		if base == "" {
			http.Error(w, `{"detail":"Unknown model"}`, http.StatusNotFound)
			return
		}

		target := base + "/v1/" + sub
		if !strings.HasSuffix(sub, "/") && r.URL.RawQuery != "" {
			target += "?" + r.URL.RawQuery
		}

		ctx, cancel := context.WithTimeout(r.Context(), 120*time.Second)
		defer cancel()
		req, err := http.NewRequestWithContext(ctx, r.Method, target, bytes.NewReader(body))
		if err != nil {
			http.Error(w, "upstream", http.StatusBadGateway)
			return
		}

		vkMap := loadVirtualKeyMap(vkPath)
		authTok := bearerToken(r.Header)
		meteringCompany := ""
		vkMatched := false
		if authTok != "" && len(vkMap) > 0 {
			if cid, ok := vkMap[sha256Hex(authTok)]; ok {
				vkMatched = true
				meteringCompany = cid
			}
		}

		for k, vals := range r.Header {
			kk := strings.ToLower(k)
			if kk == "host" {
				continue
			}
			if vkMatched && kk == "authorization" {
				continue
			}
			for _, v := range vals {
				req.Header.Add(k, v)
			}
		}
		if key != "" {
			req.Header.Set("Authorization", "Bearer "+key)
		}

		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			http.Error(w, "upstream error", http.StatusBadGateway)
			return
		}
		defer resp.Body.Close()
		upBody, err := io.ReadAll(io.LimitReader(resp.Body, 64<<20))
		if err != nil {
			http.Error(w, "upstream read", http.StatusBadGateway)
			return
		}
		ct := resp.Header.Get("Content-Type")
		if vkMatched && meterURL != "" && resp.StatusCode == http.StatusOK && strings.Contains(ct, "json") {
			var wrapped struct {
				Usage openAIUsage `json:"usage"`
			}
			if err := json.Unmarshal(upBody, &wrapped); err == nil {
				go postMeteringAsync(meterURL, meterBearer, meteringCompany, modelID, wrapped.Usage.PromptTokens, wrapped.Usage.CompletionTokens)
			}
		}
		if ct != "" {
			w.Header().Set("Content-Type", ct)
		}
		w.WriteHeader(resp.StatusCode)
		_, _ = w.Write(upBody)
	})

	log.Printf("model-gateway listening on %s config=%s", addr, filepath.Clean(configPath))
	if err := http.ListenAndServe(addr, mux); err != nil {
		log.Fatal(err)
	}
}
