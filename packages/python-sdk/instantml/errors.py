"""Public exception types for the SDK."""

from __future__ import annotations


class InstantMLError(Exception):
    """Raised when the SDK cannot complete a logging request."""


class UnsupportedOfflineOperation(InstantMLError):
    """Raised when an operation cannot be recorded in ``mode="offline"``.

    Offline runs write a self-describing local directory that ``instantml sync``
    replays later. A handful of operations need a live server response mid-call
    (versioned-artifact multipart uploads and media helpers that chain on the
    upload response) and therefore cannot be spooled offline. Those raise this
    error at call time, naming the online alternative.
    """
