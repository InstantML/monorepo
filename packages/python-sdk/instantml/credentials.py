"""API-key resolution and credential checks."""

from __future__ import annotations

import os

from .errors import InstantMLError


def _resolve_api_key(api_key: str | None, base_url: str | None = None) -> str | None:
    """Resolve the API key using the priority chain:
    1. Explicit api_key kwarg.
    2. INSTANTML_API_KEY environment variable.
    3. ~/.instantml/credentials file.
    Returns the resolved key or None (for unauthenticated local mode).
    """
    if api_key:
        return api_key
    env_key = os.environ.get("INSTANTML_API_KEY")
    if env_key:
        return env_key
    try:
        from .cli import resolve_api_key_from_credentials
        file_key = resolve_api_key_from_credentials()
        if file_key:
            return file_key
    except ImportError:
        pass
    return None


def _check_credentials_or_raise(api_key: str | None) -> None:
    """Raise InstantMLError when no credentials are available via any resolution path."""
    if api_key:
        return
    if os.environ.get("INSTANTML_API_KEY"):
        return
    try:
        from .cli import resolve_api_key_from_credentials
        if resolve_api_key_from_credentials():
            return
    except ImportError:
        pass
    raise InstantMLError(
        "InstantML credentials not configured. "
        "Run `instantml login` to authenticate, or set INSTANTML_API_KEY in your environment."
    )
