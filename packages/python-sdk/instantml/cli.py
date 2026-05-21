"""instantml CLI — device-code login, logout, and whoami commands."""

from __future__ import annotations

import json
import os
import stat
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any


_CREDENTIALS_PATH = Path.home() / ".instantml" / "credentials"
_DEFAULT_API_HOST = os.environ.get("INSTANTML_API_BASE_URL") or "https://api.instantml.ai"
_POLL_TIMEOUT_SECS = 120  # how long to poll before giving up (safety cap)


# ---------------------------------------------------------------------------
# Credential file helpers
# ---------------------------------------------------------------------------


def credentials_path() -> Path:
    """Return the canonical path to the credentials file."""
    return _CREDENTIALS_PATH


def load_credentials() -> dict[str, str]:
    """Load credentials from ~/.instantml/credentials.

    Returns an empty dict if the file does not exist or cannot be parsed.
    Values are returned as strings.
    """
    path = _CREDENTIALS_PATH
    if not path.exists():
        return {}
    try:
        return _parse_toml_simple(path.read_text(encoding="utf-8"))
    except Exception:
        return {}


def write_credentials(
    api_key: str,
    api_host: str,
    org_id: str,
    user_email: str,
) -> None:
    """Write credentials to ~/.instantml/credentials (mode 0600)."""
    path = _CREDENTIALS_PATH
    path.parent.mkdir(parents=True, exist_ok=True)
    content = "\n".join(
        [
            f'api_key = "{api_key}"',
            f'api_host = "{api_host}"',
            f'org_id = "{org_id}"',
            f'user_email = "{user_email}"',
            "",
        ]
    )
    # Write with restricted permissions so other users cannot read the key.
    path.write_text(content, encoding="utf-8")
    path.chmod(stat.S_IRUSR | stat.S_IWUSR)


def delete_credentials() -> bool:
    """Remove the credentials file. Returns True if a file was removed."""
    path = _CREDENTIALS_PATH
    if path.exists():
        path.unlink()
        return True
    return False


def resolve_api_key_from_credentials() -> str | None:
    """Return api_key from ~/.instantml/credentials, or None."""
    return load_credentials().get("api_key")


# ---------------------------------------------------------------------------
# Minimal TOML parser (key = "value" lines only — avoids toml dependency)
# ---------------------------------------------------------------------------


def _parse_toml_simple(text: str) -> dict[str, str]:
    """Parse a flat TOML file with only simple string assignments."""
    result: dict[str, str] = {}
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if "=" not in line:
            continue
        key, _, raw_value = line.partition("=")
        key = key.strip()
        raw_value = raw_value.strip()
        # Strip surrounding quotes if present.
        if (raw_value.startswith('"') and raw_value.endswith('"')) or (
            raw_value.startswith("'") and raw_value.endswith("'")
        ):
            raw_value = raw_value[1:-1]
        result[key] = raw_value
    return result


# ---------------------------------------------------------------------------
# HTTP helpers (no external deps — stdlib only)
# ---------------------------------------------------------------------------


def _post(host: str, path: str, body: dict[str, Any], timeout: float = 10.0) -> dict[str, Any]:
    url = host.rstrip("/") + path
    data = json.dumps(body).encode("utf-8")
    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json",
    }
    req = urllib.request.Request(url, data=data, method="POST", headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        body_bytes = exc.read()
        try:
            err = json.loads(body_bytes.decode("utf-8"))
            code = err.get("code", "")
            message = err.get("error", str(exc))
        except Exception:
            code = ""
            message = str(exc)
        raise _ApiError(exc.code, code, message) from exc
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise _ApiError(0, "network_error", str(exc)) from exc


class _ApiError(Exception):
    def __init__(self, status: int, code: str, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message


# ---------------------------------------------------------------------------
# login command
# ---------------------------------------------------------------------------


def cmd_login(api_host: str = _DEFAULT_API_HOST) -> None:
    """Start a device-code login flow and write credentials on success."""
    import importlib

    print(f"Connecting to {api_host} ...")

    client_info: dict[str, Any] = {"name": "instantml-cli", "version": _sdk_version()}
    try:
        resp = _post(api_host, "/api/auth/device-code/start", {"client_info": client_info})
    except _ApiError as exc:
        _die(f"Failed to start login: {exc.message}")

    device_code: str = resp.get("device_code", "")
    user_code: str = resp.get("user_code", "")
    verification_uri: str = resp.get("verification_uri", "")
    verification_uri_complete: str = resp.get("verification_uri_complete", verification_uri)
    expires_in: int = int(resp.get("expires_in", 900))
    interval: int = int(resp.get("interval", 5))

    if not device_code or not user_code:
        _die("Server returned an invalid device-code response.")

    print()
    print("=" * 60)
    print(f"  Your confirmation code: {user_code}")
    print()
    print(f"  1. Open:  {verification_uri}")
    print(f"  2. Enter the code above and click 'Confirm device'.")
    print("=" * 60)
    print()

    # Try to open the browser automatically.
    try:
        import webbrowser
        webbrowser.open(verification_uri_complete)
        print("  (Browser opened automatically — confirm the code there.)")
    except Exception:
        print("  (Could not open browser automatically.)")

    print()
    print(f"Waiting for you to confirm in the browser (expires in {expires_in}s) ...")
    print("Press Ctrl+C to cancel.")
    print()

    deadline = time.monotonic() + min(expires_in, _POLL_TIMEOUT_SECS)
    try:
        while time.monotonic() < deadline:
            time.sleep(interval)
            try:
                poll = _post(
                    api_host,
                    "/api/auth/device-code/poll",
                    {"device_code": device_code},
                    timeout=10.0,
                )
            except _ApiError as exc:
                if exc.code == "slow_down":
                    # Server asked us to back off.
                    interval = max(interval + 5, int(exc.status or interval + 5))
                    continue
                print(f"Warning: poll error ({exc.message}), retrying ...")
                continue

            status = poll.get("status", "")
            if status == "pending":
                continue
            if status == "authorized":
                _handle_authorized(poll, api_host)
                return
            if status == "denied":
                _die("Login was denied.")
            if status == "expired":
                _die("The device code expired before you confirmed. Run `instantml login` again.")
            # Unknown status: keep polling.
    except KeyboardInterrupt:
        print("\nLogin cancelled.")
        sys.exit(1)

    _die("Timed out waiting for confirmation. Run `instantml login` again.")


def _handle_authorized(poll: dict[str, Any], api_host: str) -> None:
    api_key_info = poll.get("api_key") or {}
    org_info = poll.get("org") or {}
    user_info = poll.get("user") or {}

    plaintext = api_key_info.get("plaintext", "") if isinstance(api_key_info, dict) else ""
    org_id = str(org_info.get("id", "")) if isinstance(org_info, dict) else ""
    org_name = str(org_info.get("name", "")) if isinstance(org_info, dict) else ""
    user_email = str(user_info.get("primary_email", "")) if isinstance(user_info, dict) else ""

    if not plaintext:
        _die("Server did not return an API key. Please try again or contact support.")

    write_credentials(
        api_key=plaintext,
        api_host=api_host,
        org_id=org_id,
        user_email=user_email,
    )

    print()
    print("Login successful!")
    if org_name:
        print(f"  Organization: {org_name}")
    if user_email:
        print(f"  Email:        {user_email}")
    print(f"  Credentials:  {_CREDENTIALS_PATH}")
    print()
    print("You can now use `import instantml as iml; iml.init(...)` without providing an API key.")
    print()


# ---------------------------------------------------------------------------
# logout command
# ---------------------------------------------------------------------------


def cmd_logout() -> None:
    """Remove the credentials file."""
    removed = delete_credentials()
    if removed:
        print(f"Credentials removed: {_CREDENTIALS_PATH}")
    else:
        print("No credentials file found.")


# ---------------------------------------------------------------------------
# whoami command
# ---------------------------------------------------------------------------


def cmd_whoami() -> None:
    """Print the current org/user from the credentials file."""
    creds = load_credentials()
    if not creds:
        print("Not logged in. Run `instantml login` to set up credentials.")
        sys.exit(1)
    print(f"api_host:   {creds.get('api_host', '(not set)')}")
    print(f"org_id:     {creds.get('org_id', '(not set)')}")
    print(f"user_email: {creds.get('user_email', '(not set)')}")
    key = creds.get("api_key", "")
    if key:
        print(f"api_key:    {key[:14]}...")
    else:
        print("api_key:    (not set)")


# ---------------------------------------------------------------------------
# Main entrypoint
# ---------------------------------------------------------------------------


def main(argv: list[str] | None = None) -> None:
    """Parse argv and dispatch to a subcommand."""
    if argv is None:
        argv = sys.argv[1:]

    if not argv or argv[0] in ("-h", "--help"):
        _print_help()
        return

    subcommand = argv[0]
    rest = argv[1:]

    if subcommand == "login":
        api_host = _DEFAULT_API_HOST
        i = 0
        while i < len(rest):
            if rest[i] in ("--api-host",) and i + 1 < len(rest):
                api_host = rest[i + 1]
                i += 2
            else:
                _die(f"Unknown option: {rest[i]}")
        cmd_login(api_host=api_host)

    elif subcommand == "logout":
        cmd_logout()

    elif subcommand == "whoami":
        cmd_whoami()

    else:
        _die(f"Unknown subcommand '{subcommand}'. Run `instantml --help` for usage.")


def _print_help() -> None:
    print(
        """\
instantml — CLI for InstantML experiment tracking

Usage:
  instantml login [--api-host URL]
      Start a browser-based device login flow and write credentials to
      ~/.instantml/credentials.

  instantml logout
      Remove credentials from ~/.instantml/credentials.

  instantml whoami
      Print the current org/user from the stored credentials.

  instantml --help
      Show this message.
"""
    )


def _sdk_version() -> str:
    try:
        from importlib.metadata import version
        return version("instantml")
    except Exception:
        return "unknown"


def _die(message: str) -> None:
    print(f"Error: {message}", file=sys.stderr)
    sys.exit(1)
