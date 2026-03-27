"""Unit tests for docindex_jobs — HMAC signing, chunk id, file byte hash."""

from __future__ import annotations

import copy

from docindex_jobs import hash_file_bytes, make_chunk_id, sign_job, verify_job


def test_sign_job_returns_64_char_hex():
    sig = sign_job({"job_id": "a", "rel_path": "x.md"}, "k")
    assert len(sig) == 64
    assert sig == sig.lower()
    assert all(c in "0123456789abcdef" for c in sig)


def test_verify_job_round_trip():
    job = {
        "job_id": "j1",
        "rel_path": "docs/a.md",
        "source_id": "s1",
        "acl_scope": "public",
        "file_bytes_hash": "abc123",
    }
    key = "shared-secret-key"
    sig = sign_job(job, key)
    assert verify_job(job, sig, key) is True


def test_verify_job_false_when_field_mutated():
    job = {
        "job_id": "j1",
        "rel_path": "docs/a.md",
        "source_id": "s1",
        "acl_scope": "public",
        "file_bytes_hash": "",
    }
    key = "k"
    sig = sign_job(job, key)
    job2 = copy.deepcopy(job)
    job2["rel_path"] = "docs/b.md"
    assert verify_job(job2, sig, key) is False


def test_verify_job_false_wrong_key():
    job = {"job_id": "j1", "rel_path": "x", "source_id": "s", "acl_scope": "public", "file_bytes_hash": ""}
    sig = sign_job(job, "key-a")
    assert verify_job(job, sig, "key-b") is False


def test_make_chunk_id_deterministic():
    a = make_chunk_id("s", "f.md", 0, "h1")
    b = make_chunk_id("s", "f.md", 0, "h1")
    assert a == b
    assert len(a) == 32


def test_make_chunk_id_changes_with_inputs():
    base = make_chunk_id("s", "f.md", 0, "h")
    assert make_chunk_id("s2", "f.md", 0, "h") != base
    assert make_chunk_id("s", "g.md", 0, "h") != base
    assert make_chunk_id("s", "f.md", 1, "h") != base
    assert make_chunk_id("s", "f.md", 0, "h2") != base


def test_hash_file_bytes_16_char_hex(tmp_path):
    p = tmp_path / "blob.bin"
    p.write_bytes(b"hello world bytes")
    h = hash_file_bytes(str(p))
    assert len(h) == 16
    assert all(c in "0123456789abcdef" for c in h)


def test_sign_verify_mirrors_worker_pop_sig_flow():
    """API signs payload without sig; worker receives dict with sig, pops it, verifies remainder."""
    job = {
        "job_id": "jid",
        "rel_path": "note.md",
        "source_id": "src",
        "acl_scope": "public",
        "file_bytes_hash": "deadbeef",
    }
    key = "job-signing-key"
    sig = sign_job(job, key)
    on_wire = {**job, "sig": sig}
    worker_job = dict(on_wire)
    popped = worker_job.pop("sig", None)
    assert popped is not None
    assert verify_job(worker_job, popped, key) is True
