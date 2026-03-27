"""Safe LanceDB filter helpers in docindex_server."""

import pytest

import docindex_server as ds


def test_safe_str_filter_ok():
    assert ds._safe_str_filter("source_id", "tenant1") == "source_id = 'tenant1'"


def test_safe_str_filter_rejects_injection():
    with pytest.raises(ValueError):
        ds._safe_str_filter("source_id", "x' OR 1=1 --")


def test_safe_str_filter_rejects_oversized_value():
    with pytest.raises(ValueError):
        ds._safe_str_filter("source_id", "a" * (ds._SAFE_STR_FILTER_MAX_LEN + 1))


def test_safe_path_filter_ok():
    assert ds._safe_path_filter("file_path", "policies/handbook.pdf") == (
        "file_path = 'policies/handbook.pdf'"
    )


def test_safe_path_filter_rejects_traversal():
    with pytest.raises(ValueError):
        ds._safe_path_filter("file_path", "../etc/passwd")


def test_safe_mime_filter_ok():
    assert ds._safe_mime_filter("mime", "application/pdf") == "mime = 'application/pdf'"


def test_safe_mime_filter_rejects_quote():
    with pytest.raises(ValueError):
        ds._safe_mime_filter("mime", "application/pdf'")


def test_safe_principal_filter_ok():
    result = ds._safe_principal_filter("team-a")
    assert "acl_scope = 'public'" in result
    assert "acl_principals LIKE '%team-a%'" in result


def test_safe_principal_filter_rejects_quote():
    with pytest.raises(ValueError):
        ds._safe_principal_filter("team' OR 1=1")


def test_safe_principal_filter_rejects_space():
    with pytest.raises(ValueError):
        ds._safe_principal_filter("team a")
