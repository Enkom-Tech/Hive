#!/usr/bin/env python3
"""
Minimal HTTP server that accepts Hive model-training dispatch and POSTs callback.
No dependencies beyond stdlib. For production, replace with your training job.
"""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import Any


PORT = int(os.environ.get("HIVE_REFERENCE_RUNNER_PORT", "8099"))


def _post_json(url: str, token: str, body: dict[str, Any]) -> None:
    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {token}",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        if resp.status >= 400:
            raise RuntimeError(f"callback HTTP {resp.status}")


class Handler(BaseHTTPRequestHandler):
    def do_POST(self) -> None:
        if self.path not in ("/train", "/"):
            self.send_error(404)
            return
        length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(length)
        try:
            payload = json.loads(raw.decode("utf-8"))
        except json.JSONDecodeError:
            self.send_error(400, "invalid json")
            return

        run_id = payload.get("hiveTrainingRunId")
        callback_url = payload.get("callbackUrl")
        token = payload.get("callbackToken")
        slug = payload.get("proposedModelSlug", "stub-model")

        if not (run_id and callback_url and token):
            self.send_error(400, "missing hiveTrainingRunId, callbackUrl, or callbackToken")
            return

        # Optional: pull dataset export to verify connectivity (not stored)
        export_url = payload.get("datasetExportUrl")
        if isinstance(export_url, str) and export_url:
            try:
                ex_req = urllib.request.Request(
                    export_url,
                    headers={"Authorization": f"Bearer {token}"},
                    method="GET",
                )
                with urllib.request.urlopen(ex_req, timeout=60) as er:
                    _ = er.read(8192)
            except urllib.error.HTTPError as e:
                sys.stderr.write(f"dataset export fetch failed: {e}\n")

        try:
            _post_json(
                callback_url,
                token,
                {
                    "runId": run_id,
                    "status": "running",
                    "resultMetadata": {"stub": True},
                },
            )
            # Stub: pretend serving URL — replace with real vLLM/SGLang/OpenAI-compatible base
            fake_base = os.environ.get(
                "HIVE_STUB_RESULT_BASE_URL",
                "http://127.0.0.1:9999/v1",
            )
            _post_json(
                callback_url,
                token,
                {
                    "runId": run_id,
                    "status": "succeeded",
                    "resultBaseUrl": fake_base,
                    "resultMetadata": {
                        "stub": True,
                        "proposedModelSlug": slug,
                        "eval": {"metrics": {"stub_score": 1.0}},
                    },
                },
            )
        except Exception as e:
            sys.stderr.write(f"callback failed: {e}\n")
            self.send_error(500, str(e))
            return

        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(b'{"ok":true}')

    def log_message(self, format: str, *args: object) -> None:
        # Redact paths that might appear in logs
        sys.stderr.write("%s - - [%s] %s\n" % (self.address_string(), self.log_date_time_string(), format % args))


def main() -> None:
    server = HTTPServer(("0.0.0.0", PORT), Handler)
    print(f"stub_runner listening on :{PORT} POST /train", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
