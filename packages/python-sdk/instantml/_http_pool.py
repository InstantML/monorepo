"""Shared keep-alive HTTP connection pool for SDK request paths (stdlib-only).

Every SDK request used to go through ``urllib.request.urlopen``, paying a fresh
TCP+TLS handshake per call. This module keeps a small pool of persistent
``http.client`` connections keyed by scheme/host/port and mirrors the
``urlopen`` surface (same ``Request`` input, same ``HTTPError``/``URLError``
exceptions, same context-manager response) so call sites keep their existing
retry and error-mapping behavior.

JSON bodies larger than ``GZIP_MIN_BYTES`` are sent with
``Content-Encoding: gzip``. Older servers that cannot decode gzip bodies reject
them with a 4xx before applying any side effects; on the first such rejection
the pool permanently (for the process) disables compression and resends the
request uncompressed.
"""

from __future__ import annotations

import gzip
import http.client
import io
import threading
import urllib.error
import urllib.parse
import urllib.request

GZIP_MIN_BYTES = 1024
_GZIP_FALLBACK_STATUSES = {400, 415, 422}
_MAX_IDLE_PER_HOST = 4

_gzip_disabled = False


class _PooledResponse:
    """Fully-buffered response mirroring the ``urlopen`` response surface."""

    def __init__(self, status: int, reason: str, headers: object, payload: bytes) -> None:
        self.status = status
        self.reason = reason
        self.headers = headers
        self._payload = payload

    def read(self) -> bytes:
        payload = self._payload
        self._payload = b""
        return payload

    def __enter__(self) -> "_PooledResponse":
        return self

    def __exit__(self, exc_type: object, exc: object, traceback: object) -> None:
        return None


class _ConnectionPool:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._idle: dict[tuple[str, str, int], list[http.client.HTTPConnection]] = {}

    def urlopen(self, request: urllib.request.Request, timeout: float) -> _PooledResponse:
        url = request.full_url
        parsed = urllib.parse.urlsplit(url)
        scheme = parsed.scheme
        host = parsed.hostname or ""
        port = parsed.port or (443 if scheme == "https" else 80)
        if scheme not in {"http", "https"} or not host:
            raise urllib.error.URLError(f"unsupported pool URL: {url}")
        if _proxied(scheme, host):
            # urllib honors proxy environment variables; the pool does not.
            with urllib.request.urlopen(request, timeout=timeout) as response:  # noqa: S310 - same trust as before
                return _PooledResponse(
                    int(getattr(response, "status", 200)),
                    str(getattr(response, "reason", "")),
                    response.headers,
                    response.read(),
                )
        key = (scheme, host, port)
        method = request.get_method()
        headers = {name: value for name, value in request.header_items()}
        body = request.data
        body, headers = _maybe_compress(body, headers)
        try:
            status, reason, response_headers, payload = self._perform(key, method, request.selector, body, headers, timeout)
        except http.client.HTTPException as exc:
            raise urllib.error.URLError(exc) from exc
        if _should_retry_uncompressed(status, headers):
            _disable_gzip()
            plain_headers = {name: value for name, value in request.header_items()}
            try:
                status, reason, response_headers, payload = self._perform(
                    key, method, request.selector, request.data, plain_headers, timeout
                )
            except http.client.HTTPException as exc:
                raise urllib.error.URLError(exc) from exc
        if status >= 400:
            raise urllib.error.HTTPError(url, status, reason, response_headers, io.BytesIO(payload))
        return _PooledResponse(status, reason, response_headers, payload)

    def _perform(
        self,
        key: tuple[str, str, int],
        method: str,
        selector: str,
        body: bytes | None,
        headers: dict[str, str],
        timeout: float,
    ) -> tuple[int, str, object, bytes]:
        reused, connection = self._acquire(key, timeout)
        try:
            response = self._round_trip(connection, method, selector, body, headers)
        except (ConnectionError, BrokenPipeError, http.client.HTTPException):
            connection.close()
            if not reused:
                raise
            # Keep-alive sockets die silently between drain cycles; retry once
            # on a fresh connection before surfacing the error.
            connection = self._open(key, timeout)
            try:
                response = self._round_trip(connection, method, selector, body, headers)
            except (ConnectionError, BrokenPipeError, http.client.HTTPException):
                connection.close()
                raise
        except OSError:
            connection.close()
            raise
        try:
            payload = response.read()
        except OSError:
            connection.close()
            raise
        if response.will_close:
            connection.close()
        else:
            self._release(key, connection)
        return int(response.status), str(response.reason), response.headers, payload

    def _round_trip(
        self,
        connection: http.client.HTTPConnection,
        method: str,
        selector: str,
        body: bytes | None,
        headers: dict[str, str],
    ) -> http.client.HTTPResponse:
        connection.request(method, selector, body=body, headers=headers)
        return connection.getresponse()

    def _acquire(self, key: tuple[str, str, int], timeout: float) -> tuple[bool, http.client.HTTPConnection]:
        with self._lock:
            idle = self._idle.get(key)
            connection = idle.pop() if idle else None
        if connection is None:
            return False, self._open(key, timeout)
        connection.timeout = timeout
        if connection.sock is not None:
            connection.sock.settimeout(timeout)
        return True, connection

    def _open(self, key: tuple[str, str, int], timeout: float) -> http.client.HTTPConnection:
        scheme, host, port = key
        if scheme == "https":
            return http.client.HTTPSConnection(host, port, timeout=timeout)
        return http.client.HTTPConnection(host, port, timeout=timeout)

    def _release(self, key: tuple[str, str, int], connection: http.client.HTTPConnection) -> None:
        with self._lock:
            idle = self._idle.setdefault(key, [])
            if len(idle) < _MAX_IDLE_PER_HOST:
                idle.append(connection)
                return
        connection.close()

    def close_all(self) -> None:
        with self._lock:
            connections = [connection for idle in self._idle.values() for connection in idle]
            self._idle.clear()
        for connection in connections:
            connection.close()


def _maybe_compress(body: bytes | None, headers: dict[str, str]) -> tuple[bytes | None, dict[str, str]]:
    if _gzip_disabled or body is None or len(body) <= GZIP_MIN_BYTES:
        return body, headers
    if not _is_json_content(headers) or _header_lookup(headers, "Content-Encoding") is not None:
        return body, headers
    compressed = gzip.compress(body, compresslevel=6)
    updated = dict(headers)
    updated["Content-Encoding"] = "gzip"
    return compressed, updated


def _should_retry_uncompressed(status: int, sent_headers: dict[str, str]) -> bool:
    return status in _GZIP_FALLBACK_STATUSES and _header_lookup(sent_headers, "Content-Encoding") == "gzip"


def _is_json_content(headers: dict[str, str]) -> bool:
    content_type = _header_lookup(headers, "Content-Type") or ""
    return "json" in content_type.lower()


def _header_lookup(headers: dict[str, str], name: str) -> str | None:
    lowered = name.lower()
    for key, value in headers.items():
        if key.lower() == lowered:
            return value
    return None


def _proxied(scheme: str, host: str) -> bool:
    proxies = urllib.request.getproxies()
    if scheme not in proxies:
        return False
    return not urllib.request.proxy_bypass(host)


def _disable_gzip() -> None:
    global _gzip_disabled
    _gzip_disabled = True


_POOL = _ConnectionPool()


def urlopen(request: urllib.request.Request, timeout: float) -> _PooledResponse:
    """Pool-backed drop-in for ``urllib.request.urlopen(request, timeout=...)``."""
    return _POOL.urlopen(request, timeout)
