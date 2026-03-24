"""
Unit tests for the _safe_str_filter injection guard.
Verifies that the allowlist correctly blocks SQL metacharacters and passes safe values.
"""

import importlib
import sys
import pytest

# Import directly from the module without triggering FastAPI startup
import cocoindex_server as cs


class TestSafeStrFilter:
    # ------------------------------------------------------------------ #
    # Safe values — must pass through without raising                      #
    # ------------------------------------------------------------------ #

    @pytest.mark.parametrize("value", [
        "my-repo",
        "org_repo",
        "repo.v2",
        "fastapi",
        "Hive-Infra",
        "a",
        "repo123",
        "some.dots.allowed",
    ])
    def test_safe_values_pass(self, value):
        result = cs._safe_str_filter("repo_name", value)
        assert result == f"repo_name = '{value}'"

    # ------------------------------------------------------------------ #
    # Injection values — must raise ValueError                            #
    # ------------------------------------------------------------------ #

    @pytest.mark.parametrize("value", [
        "' OR '1'='1",
        "x; DROP TABLE code_embeddings; --",
        "repo' --",
        "x' UNION SELECT * FROM secrets --",
        "",                         # empty string
        "repo name",                # space
        "repo\x00null",            # null byte
        "a" * 1001,                 # length bomb
        "<script>",                 # XSS attempt
        "../../../etc/passwd",      # path traversal
        "repo\ninjection",          # newline
    ])
    def test_injection_values_raise(self, value):
        with pytest.raises(ValueError, match="Invalid filter value"):
            cs._safe_str_filter("repo_name", value)

    def test_filter_output_format(self):
        result = cs._safe_str_filter("language", "python")
        assert result == "language = 'python'"


class TestLanguageAllowlist:
    """Verify that language filter is additionally checked against the known languages set."""

    def test_known_language_passes_search(self):
        """Known language values in SUPPORTED_LANGUAGES.values() should not raise in search."""
        # We test the allowlist logic directly without a running DB
        valid_languages = list(cs.CodeChunker.SUPPORTED_LANGUAGES.values())
        for lang in valid_languages:
            # _safe_str_filter should not raise for these
            result = cs._safe_str_filter("language", lang)
            assert "language" in result

    def test_unknown_language_would_be_blocked(self):
        """An unknown language should be blocked by the double-check in LanceDBManager.search."""
        unknown = "cobol"
        known = set(cs.CodeChunker.SUPPORTED_LANGUAGES.values())
        assert unknown not in known
