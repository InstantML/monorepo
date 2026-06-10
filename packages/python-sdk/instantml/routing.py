"""Hosted data-cell route discovery helpers."""

from __future__ import annotations

import json
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone


ROUTE_DISCOVERY_PATH = "/api/routing/current"
ROUTE_VERSION_HEADER = "X-InstantML-Route-Version"
ROUTE_REFRESH_CODES = {"tenant_route_changed", "wrong_cell"}
ROUTE_REFRESH_STATUSES = {401, 403, 404}
ROUTE_CACHE_SKEW_SECONDS = 5.0

_DIRECT_METHODS = {"DELETE", "PATCH", "POST", "PUT"}
_DIRECT_PATH_PREFIXES = (
    "/projects",
    "/runs",
    "/api/runs",
    "/api/artifact-collections",
    "/api/artifact-uploads",
    "/api/artifact-versions",
    "/api/imports",
)


@dataclass(frozen=True)
class RouteInfo:
    data_api_base: str
    route_version: int
    expires_at: float


def should_direct_route(method: str, path: str) -> bool:
    if method.upper() not in _DIRECT_METHODS:
        return False
    path_only = urllib.parse.urlsplit(path).path
    return any(path_only == prefix or path_only.startswith(f"{prefix}/") for prefix in _DIRECT_PATH_PREFIXES)


def route_headers(route: RouteInfo | None) -> dict[str, str]:
    if route is None:
        return {}
    return {ROUTE_VERSION_HEADER: str(route.route_version)}


def should_refresh_route(code: str | None = None, status: int | None = None) -> bool:
    return code in ROUTE_REFRESH_CODES or status in ROUTE_REFRESH_STATUSES


def resolve_route(
    cache: dict[str, RouteInfo],
    lock: threading.RLock,
    *,
    base_url: str,
    api_key: str,
    timeout: float,
    force: bool = False,
) -> RouteInfo | None:
    cache_key = _cache_key(base_url, api_key)
    now = time.time()
    with lock:
        cached = cache.get(cache_key)
        if not force and cached is not None and cached.expires_at > now + ROUTE_CACHE_SKEW_SECONDS:
            return cached
    route = _fetch_route(base_url=base_url, api_key=api_key, timeout=timeout)
    if route is None:
        return None
    with lock:
        cache[cache_key] = route
    return route


def clear_route(cache: dict[str, RouteInfo], lock: threading.RLock, *, base_url: str, api_key: str) -> None:
    with lock:
        cache.pop(_cache_key(base_url, api_key), None)


def _fetch_route(*, base_url: str, api_key: str, timeout: float) -> RouteInfo | None:
    request = urllib.request.Request(
        base_url.rstrip("/") + ROUTE_DISCOVERY_PATH,
        method="GET",
        headers={"Accept": "application/json", "Authorization": f"Bearer {api_key}"},
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            payload = response.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        try:
            exc.read()
        except OSError:
            pass
        return None
    except (UnicodeDecodeError, urllib.error.URLError, TimeoutError, OSError):
        return None
    try:
        decoded = json.loads(payload)
    except json.JSONDecodeError:
        return None
    if not isinstance(decoded, dict):
        return None
    return _route_from_payload(decoded)


def _route_from_payload(payload: dict[str, object]) -> RouteInfo | None:
    data_api_base = payload.get("data_api_base")
    expires_at = payload.get("expires_at")
    if not isinstance(data_api_base, str) or not isinstance(expires_at, str):
        return None
    try:
        route_version = int(payload.get("route_version", 0))
        parsed_expires_at = datetime.fromisoformat(expires_at.replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None
    if route_version <= 0:
        return None
    if parsed_expires_at.tzinfo is None:
        parsed_expires_at = parsed_expires_at.replace(tzinfo=timezone.utc)
    return RouteInfo(
        data_api_base=data_api_base.rstrip("/"),
        route_version=route_version,
        expires_at=parsed_expires_at.timestamp(),
    )


def _cache_key(base_url: str, api_key: str) -> str:
    return f"{base_url.rstrip('/')}\0{api_key}"
