"""API-key resolution and credential checks."""

from __future__ import annotations

import os
import urllib.parse

from .errors import InstantMLError


_LOCAL_API_KEY_SENTINELS = {"local", "instantml_local"}


def _is_loopback_base_url(value: str | None) -> bool:
    if not value:
        return False
    try:
        host = urllib.parse.urlparse(value).hostname or ""
    except Exception:
        return False
    return host in {"localhost", "127.0.0.1", "::1"}


def _is_local_sentinel(value: str | None) -> bool:
    return (value or "").strip().lower() in _LOCAL_API_KEY_SENTINELS


def _credentials() -> dict[str, str]:
    try:
        from .cli import load_effective_credentials
        return load_effective_credentials()
    except ImportError:
        return {}


def _resolve_api_key(api_key: str | None, base_url: str | None = None) -> str | None:
    """Resolve the API key using the priority chain:
    1. Explicit api_key kwarg.
    2. INSTANTML_API_KEY environment variable.
    3. ~/.instantml/credentials file.
    Returns the resolved key or None (for unauthenticated local mode).
    """
    effective_base_url = base_url or os.environ.get("INSTANTML_API_BASE_URL")
    if api_key:
        if _is_local_sentinel(api_key):
            return _resolve_local_sentinel(effective_base_url)
        return api_key
    env_key = os.environ.get("INSTANTML_API_KEY")
    if env_key:
        if _is_local_sentinel(env_key):
            return _resolve_local_sentinel(effective_base_url)
        return env_key
    creds = _credentials()
    file_key = creds.get("api_key")
    effective_base_url = effective_base_url or os.environ.get("INSTANTML_API_BASE_URL") or creds.get("api_host")
    if _is_local_sentinel(file_key):
        return _resolve_local_sentinel(effective_base_url)
    if file_key:
        return file_key
    return None


def _resolve_local_sentinel(base_url: str | None) -> None:
    if _is_loopback_base_url(base_url):
        return None
    raise _missing_credentials_error()


def _check_credentials_or_raise(api_key: str | None, base_url: str | None = None) -> None:
    """Raise InstantMLError when no credentials are available via any resolution path."""
    effective_base_url = base_url or os.environ.get("INSTANTML_API_BASE_URL")
    if api_key:
        if _is_local_sentinel(api_key):
            if _is_loopback_base_url(effective_base_url):
                return
            raise _missing_credentials_error()
        else:
            return
    env_key = os.environ.get("INSTANTML_API_KEY")
    if env_key:
        if _is_local_sentinel(env_key):
            if _is_loopback_base_url(effective_base_url):
                return
            raise _missing_credentials_error()
        else:
            return
    creds = _credentials()
    file_key = creds.get("api_key")
    effective_base_url = effective_base_url or os.environ.get("INSTANTML_API_BASE_URL") or creds.get("api_host")
    if _is_local_sentinel(file_key):
        if _is_loopback_base_url(effective_base_url):
            return
        raise _missing_credentials_error()
    elif file_key:
        return
    raise _missing_credentials_error()


def _missing_credentials_error() -> InstantMLError:
    return InstantMLError(
        "InstantML credentials not configured. "
        "Run `instantml login` to authenticate, or set INSTANTML_API_KEY in your environment."
    )
