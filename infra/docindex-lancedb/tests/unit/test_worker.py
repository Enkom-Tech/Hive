"""Unit tests for docindex_worker._dispatch_job — HMAC gate and timeout."""

from __future__ import annotations

import concurrent.futures as cf
from unittest.mock import MagicMock, patch

import pytest

import docindex_worker as dw
from docindex_jobs import sign_job


def _minimal_job() -> dict:
    return {
        "job_id": "job-1",
        "rel_path": "docs/note.md",
        "source_id": "src-a",
        "acl_scope": "public",
        "file_bytes_hash": "",
    }


@pytest.fixture
def http_client():
    return MagicMock()


@pytest.fixture
def redis_client():
    return MagicMock()


def test_dispatch_no_signing_key_calls_process_job(http_client, redis_client):
    job = _minimal_job()
    with patch.object(dw.settings, "job_signing_key", ""):
        with patch.object(dw, "_process_job") as m_proc:
            dw._dispatch_job(job, http_client, redis_client)
            m_proc.assert_called_once()
    args, _ = m_proc.call_args
    assert args[0]["job_id"] == "job-1"


def test_dispatch_missing_sig_when_key_set_replies_error(http_client, redis_client):
    job = _minimal_job()
    with patch.object(dw.settings, "job_signing_key", "secret-key"):
        with patch.object(dw, "_reply_error") as m_err:
            with patch.object(dw, "_process_job") as m_proc:
                dw._dispatch_job(dict(job), http_client, redis_client)
                m_err.assert_called_once()
                assert m_err.call_args[0][1] == "job-1"
                assert "missing" in m_err.call_args[0][2].lower()
                m_proc.assert_not_called()


def test_dispatch_invalid_sig_replies_error(http_client, redis_client):
    job = _minimal_job()
    job["sig"] = "0" * 64
    with patch.object(dw.settings, "job_signing_key", "secret-key"):
        with patch.object(dw, "_reply_error") as m_err:
            with patch.object(dw, "_process_job") as m_proc:
                dw._dispatch_job(dict(job), http_client, redis_client)
                m_err.assert_called_once()
                assert "invalid" in m_err.call_args[0][2].lower()
                m_proc.assert_not_called()


def test_dispatch_valid_sig_calls_process_job(http_client, redis_client):
    key = "signing-secret"
    base = _minimal_job()
    sig = sign_job(base, key)
    job = {**base, "sig": sig}
    with patch.object(dw.settings, "job_signing_key", key):
        with patch.object(dw, "_process_job") as m_proc:
            dw._dispatch_job(dict(job), http_client, redis_client)
            m_proc.assert_called_once()
    passed_job, _, _ = m_proc.call_args[0]
    assert "sig" not in passed_job
    assert passed_job["job_id"] == "job-1"


def test_dispatch_timeout_calls_reply_error(http_client, redis_client):
    job = _minimal_job()
    mock_fut = MagicMock()
    mock_fut.result.side_effect = cf.TimeoutError()
    with patch.object(dw.settings, "job_signing_key", ""):
        with patch.object(dw.settings, "job_timeout_secs", 300):
            with patch.object(dw._executor, "submit", return_value=mock_fut):
                with patch.object(dw, "_reply_error") as m_err:
                    dw._dispatch_job(dict(job), http_client, redis_client)
                    mock_fut.result.assert_called_once()
                    m_err.assert_called_once()
                    assert m_err.call_args[0][1] == "job-1"
                    assert "timed out" in m_err.call_args[0][2].lower()
