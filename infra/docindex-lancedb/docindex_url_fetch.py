"""Optional URL fetch for DocIndex with host allowlist (SSRF mitigation)."""

from __future__ import annotations

import ipaddress
import os
import socket
from pathlib import Path
from urllib.parse import urlparse

import httpx


def _allowed_hosts() -> set[str]:
    raw = os.environ.get("DOCINDEX_SCRAPE_ALLOWED_HOSTS", "").strip()
    if not raw:
        return set()
    return {h.strip().lower() for h in raw.split(",") if h.strip()}


def _max_bytes() -> int:
    try:
        return max(1024, int(os.environ.get("DOCINDEX_SCRAPE_MAX_BYTES", "1048576")))
    except ValueError:
        return 1_048_576


def _timeout_sec() -> float:
    try:
        return max(1.0, float(os.environ.get("DOCINDEX_SCRAPE_TIMEOUT_SEC", "30")))
    except ValueError:
        return 30.0


def _allow_private_ips() -> bool:
    v = os.environ.get("DOCINDEX_SCRAPE_ALLOW_PRIVATE_IPS", "").strip().lower()
    return v in ("1", "true", "yes")


def _is_blocked_ip(host: str) -> bool:
    try:
        infos = socket.getaddrinfo(host, None)
    except OSError:
        return True
    for info in infos:
        ip_str = info[4][0]
        try:
            ip = ipaddress.ip_address(ip_str)
        except ValueError:
            continue
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved:
            if not _allow_private_ips():
                return True
    return False


def fetch_url_to_dir(url: str, dest_dir: Path) -> Path:
    """Download URL body to dest_dir using a safe filename. Raises ValueError on policy violation."""
    allowed = _allowed_hosts()
    if not allowed:
        raise ValueError("DOCINDEX_SCRAPE_ALLOWED_HOSTS is not set")

    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https"):
        raise ValueError("only http/https URLs are allowed")
    host = (parsed.hostname or "").lower()
    if not host or host not in allowed:
        raise ValueError("host not in DOCINDEX_SCRAPE_ALLOWED_HOSTS")

    if _is_blocked_ip(host):
        raise ValueError("resolved IP blocked by SSRF policy")

    dest_dir.mkdir(parents=True, exist_ok=True)
    name = Path(parsed.path or "index").name or "fetched.html"
    if ".." in name or "/" in name or "\\" in name:
        name = "fetched.html"
    out = dest_dir / name

    with httpx.Client(timeout=_timeout_sec(), follow_redirects=False) as client:
        r = client.get(url)
        r.raise_for_status()
        body = r.content[: _max_bytes()]
    out.write_bytes(body)
    return out
