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
import argparse
from datetime import datetime, timezone
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
# import / sync commands
# ---------------------------------------------------------------------------


def cmd_import(rest: list[str]) -> None:
    parser = argparse.ArgumentParser(prog="instantml import")
    subparsers = parser.add_subparsers(dest="source", required=True)
    for source in ("wandb", "neptune", "mlflow"):
        sub = subparsers.add_parser(source)
        sub.add_argument("--project", required=True, help="Target InstantML project")
        sub.add_argument("--input", help="Local transformed JSON payload")
        sub.add_argument("--source-project", help="Source project name/path")
        sub.add_argument("--api-host", default=_DEFAULT_API_HOST)
        sub.add_argument("--dry-run", action="store_true")
        if source == "neptune":
            sub.add_argument("--files-path", help="Neptune Exporter files directory for artifact references")
        if source == "wandb":
            sub.add_argument("--entity", help="W&B entity for direct local export")
            sub.add_argument("--limit", type=int, help="Maximum W&B runs to export")
    args = parser.parse_args(rest)
    from . import importers

    try:
        if args.source == "wandb" and not args.input:
            if not args.entity or not args.source_project:
                _die("W&B direct import requires --entity and --source-project, or pass --input.")
            result = importers.upload_chunks(
                source_type="wandb",
                source_project=f"{args.entity}/{args.source_project}",
                target_project=args.project,
                chunks=importers.chunks_from_wandb_project(
                    args.entity,
                    args.source_project,
                    target_project=args.project,
                    limit=args.limit,
                ),
                base_url=args.api_host,
                commit=not args.dry_run,
            )
        else:
            if not args.input:
                _die(f"{args.source} import requires --input for this release.")
            input_path = Path(args.input)
            if args.source == "neptune" and (
                input_path.is_dir() or input_path.suffix.lower() == ".parquet"
            ):
                effective_source_project = args.source_project or str(input_path)
                chunks = importers.chunks_from_neptune_exporter(
                    input_path,
                    target_project=args.project,
                    source_project=effective_source_project,
                    files_path=args.files_path,
                )
                result = importers.upload_chunks(
                    source_type="neptune",
                    source_project=effective_source_project,
                    target_project=args.project,
                    chunks=chunks,
                    base_url=args.api_host,
                    commit=not args.dry_run,
                )
            else:
                result = importers.import_transformed_json(
                    source_type=args.source,
                    input_path=args.input,
                    target_project=args.project,
                    source_project=args.source_project,
                    base_url=args.api_host,
                    dry_run=args.dry_run,
                )
    except Exception as exc:
        _die(str(exc))
    _print_import_result(result)


def cmd_sync(rest: list[str]) -> None:
    # Dispatch resolution: ``tensorboard`` remains a named subcommand; any other
    # first token is treated as an offline run directory / offline root path and
    # handled by the resumable offline-directory sync (design §5). We resolve the
    # known-subcommand token before argparse so a bare path never trips the
    # subcommand parser.
    if not rest or rest[0] != "tensorboard":
        from .offline_sync import run_offline_sync

        sys.exit(run_offline_sync(rest))

    parser = argparse.ArgumentParser(prog="instantml sync")
    subparsers = parser.add_subparsers(dest="source", required=True)
    tb = subparsers.add_parser("tensorboard")
    tb.add_argument("logdir")
    tb.add_argument("--project", required=True, help="Target InstantML project")
    tb.add_argument("--run-name")
    tb.add_argument("--run-id", help="Existing InstantML run id to attach as source metadata")
    tb.add_argument("--watch", action="store_true", help="Poll the TensorBoard logdir until interrupted")
    tb.add_argument("--watch-interval", type=float, default=5.0, help="Seconds between TensorBoard watch passes")
    tb.add_argument("--max-sync-passes", type=int, help=argparse.SUPPRESS)
    tb.add_argument("--api-host", default=_DEFAULT_API_HOST)
    tb.add_argument("--dry-run", action="store_true")
    args = parser.parse_args(rest)
    from . import importers

    seen_events: set[tuple[str, str, str, str, str]] = set()
    pass_count = 0
    try:
        while True:
            result = _sync_tensorboard_once(
                args,
                importers,
                seen_events,
                allow_empty_import=pass_count == 0 and not args.run_id,
            )
            _print_import_result(result)
            pass_count += 1
            if not args.watch:
                break
            if args.max_sync_passes is not None and pass_count >= args.max_sync_passes:
                break
            time.sleep(max(0.1, float(args.watch_interval)))
    except KeyboardInterrupt:
        print("\nTensorBoard watch stopped.")
    except Exception as exc:
        _die(str(exc))


def _sync_tensorboard_once(
    args: argparse.Namespace,
    importers: Any,
    seen_events: set[tuple[str, str, str, str, str]],
    *,
    allow_empty_import: bool = False,
) -> dict[str, Any]:
    payload = importers.tensorboard_logdir_payload(args.logdir, run_name=args.run_name)
    runs = payload.get("runs") or []
    total_metrics = _filter_tensorboard_payload_events(payload, seen_events)
    if args.run_id:
        if len(runs) > 1:
            raise ValueError("TensorBoard --run-id sync requires a single TensorBoard run directory.")
        metrics = runs[0].get("metrics", []) if runs else []
        if args.dry_run:
            return {
                "job": {"id": args.run_id, "status": "dry_run_ready"},
                "summary": {"runs": 1, "metrics": len(metrics), "artifacts": 0},
            }
        from .client import Client

        client = Client(base_url=args.api_host)
        for group in _tensorboard_metric_batches(metrics):
            client._request(
                "POST",
                f"/runs/{args.run_id}/metrics",
                {
                    "metrics": group["metrics"],
                    "step": group["step"],
                    "timestamp": group.get("timestamp"),
                    "preview": False,
                    "preview_completion": 0.0,
                },
            )
        return {
            "job": {"id": args.run_id, "status": "synced"},
            "summary": {"runs": 1, "metrics": len(metrics), "artifacts": 0},
        }
    if not total_metrics and not allow_empty_import:
        return {
            "job": {"id": args.logdir, "status": "synced"},
            "summary": {"runs": len(runs) or 1, "metrics": 0, "artifacts": 0},
        }
    chunks = importers.chunks_from_transformed_json(
        payload,
        source_type="tensorboard",
        target_project=args.project,
        source_project=args.logdir,
    )
    return importers.upload_chunks(
        source_type="tensorboard",
        source_project=args.logdir,
        target_project=args.project,
        chunks=chunks,
        base_url=args.api_host,
        commit=not args.dry_run,
    )


def _filter_tensorboard_payload_events(
    payload: dict[str, Any],
    seen_events: set[tuple[str, str, str, str, str]],
) -> int:
    total_metrics = 0
    for run in payload.get("runs") or []:
        source_run_id = str(run.get("id") or run.get("name") or "")
        metrics = [
            point
            for point in run.get("metrics", [])
            if _remember_tensorboard_event(seen_events, source_run_id, point)
        ]
        run["metrics"] = metrics
        total_metrics += len(metrics)
    return total_metrics


def _tensorboard_metric_batches(metrics: list[dict[str, Any]]) -> list[dict[str, Any]]:
    grouped: dict[tuple[str, str], dict[str, Any]] = {}
    for point in metrics:
        timestamp = _rfc3339_timestamp(point.get("timestamp"))
        step = point.get("step")
        key = (str(step), timestamp or "")
        group = grouped.setdefault(key, {"step": step, "timestamp": timestamp, "metrics": {}})
        group["metrics"][str(point["key"])] = point["value"]
    return list(grouped.values())


def _rfc3339_timestamp(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return datetime.fromtimestamp(float(value), tz=timezone.utc).isoformat().replace("+00:00", "Z")
    return str(value)


def _remember_tensorboard_event(
    seen_events: set[tuple[str, str, str, str, str]],
    source_run_id: str,
    point: dict[str, Any],
) -> bool:
    key = (
        source_run_id,
        str(point.get("key", "")),
        str(point.get("step", "")),
        str(point.get("timestamp", "")),
        str(point.get("value", "")),
    )
    if key in seen_events:
        return False
    seen_events.add(key)
    return True


def _print_import_result(result: dict[str, Any]) -> None:
    job = result.get("job") or {}
    summary = result.get("summary") or job.get("summary") or {}
    print("Import job complete." if job.get("status") == "committed" else "Import job updated.")
    if job:
        print(f"  job_id: {job.get('id')}")
        print(f"  status: {job.get('status')}")
    if summary:
        print(f"  runs: {summary.get('runs', 0)}")
        print(f"  metrics: {summary.get('metrics', 0)}")
        print(f"  artifacts: {summary.get('artifacts', 0)}")


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

    elif subcommand == "import":
        cmd_import(rest)

    elif subcommand == "sync":
        cmd_sync(rest)

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

  instantml import wandb --project NAME --input wandb.json
  instantml import neptune --project NAME --input neptune.json
      Translate a local export into Import v2 chunks and commit it.

  instantml sync tensorboard LOGDIR --project NAME [--watch]
      Import or continuously sync scalar TensorBoard events from a local log directory.

  instantml sync RUN_DIR | OFFLINE_ROOT [--status] [--dry-run] [--json]
      Replay an offline run directory (mode="offline") to the server. Resumable:
      an interrupted sync re-run continues from a per-segment cursor. Exit codes:
      0 synced+complete, 3 partial (rerun), 4 permanent failure, 5 invalid dir.

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
