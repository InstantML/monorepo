"""Public exception type for the SDK."""

from __future__ import annotations


class InstantMLError(Exception):
    """Raised when the SDK cannot complete a logging request."""


class InstantMLHTTPError(InstantMLError):
    """Raised when the InstantML API returns a non-2xx response."""

    def __init__(self, message: str, *, status_code: int, code: str | None = None) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.code = code
