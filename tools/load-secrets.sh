#!/usr/bin/env bash
# Load InstantML secrets from Google Secret Manager into the current shell.
#
# Usage (preferred — exports into your current shell):
#     source tools/load-secrets.sh
#
# Usage (equivalent, for shells without `source`):
#     eval "$(tools/load-secrets.sh)"
#
# Usage (verify only, no fetch):
#     tools/load-secrets.sh --check
#
# Behavior:
#   - Reads `tools/secrets-manifest.txt` (one secret per non-comment line).
#   - For each entry, runs `gcloud secrets versions access latest --secret=<id>`
#     and exports the value to <env-var-name>.
#   - Never writes secret values to disk and never echoes them.
#   - Prints a one-line per-secret status to stderr and a final summary.
#   - With --check, only verifies each secret exists (via `gcloud secrets
#     describe`); does not access values.
#   - Idempotent: rerunning refreshes the env vars.
#
# Pattern: Secret Manager is the source of truth; `.env` is for non-secret
# local config. See docs/ops/secrets.md.

set -u

# -----------------------------------------------------------------------------
# Detect invocation mode.
# When sourced: we export directly into the caller's shell. Logs go to stderr.
# When executed: we emit `export FOO='value'` lines to stdout so the caller
#   can do `eval "$(tools/load-secrets.sh)"`. Logs still go to stderr.
# -----------------------------------------------------------------------------

_LS_SOURCED=0
# bash sets BASH_SOURCE[0] to the script path; if it differs from $0 we are sourced.
# zsh sets ${(%):-%N} to the sourced file. We approximate by checking both.
if [ -n "${BASH_SOURCE:-}" ]; then
  # shellcheck disable=SC2128
  if [ "${BASH_SOURCE}" != "${0}" ]; then
    _LS_SOURCED=1
  fi
elif [ -n "${ZSH_EVAL_CONTEXT:-}" ]; then
  case "$ZSH_EVAL_CONTEXT" in
    *:file*) _LS_SOURCED=1 ;;
  esac
fi

# -----------------------------------------------------------------------------
# Resolve repo paths.
# -----------------------------------------------------------------------------

if [ "$_LS_SOURCED" -eq 1 ] && [ -n "${BASH_SOURCE:-}" ]; then
  # shellcheck disable=SC2128
  _LS_SCRIPT="${BASH_SOURCE}"
elif [ "$_LS_SOURCED" -eq 1 ] && [ -n "${ZSH_NAME:-}" ]; then
  # zsh: ${(%):-%x} expands to current script file when sourced
  _LS_SCRIPT="${(%):-%x}"
else
  _LS_SCRIPT="$0"
fi

_LS_TOOLS_DIR="$(cd "$(dirname "$_LS_SCRIPT")" && pwd)"
_LS_MANIFEST="${INSTANTML_SECRETS_MANIFEST:-$_LS_TOOLS_DIR/secrets-manifest.txt}"

# -----------------------------------------------------------------------------
# Helpers.
# -----------------------------------------------------------------------------

# stderr logger — never touches stdout so eval "$(...)" stays clean.
_ls_log() { printf '%s\n' "$*" >&2; }

# Emit an export. When sourced, executes it in the caller; when run as a
# subprocess, prints it to stdout for the caller to eval.
_ls_emit_export() {
  # $1 = env var name (assumed sanitized [A-Z0-9_]); $2 = value (any bytes)
  local _name="$1"
  local _value="$2"

  if [ "$_LS_SOURCED" -eq 1 ]; then
    # Set in caller's environment. Use printf to be safe with newlines.
    export "$_name=$_value"
  else
    # Print a shell-safe `export NAME='value'` to stdout.
    # We single-quote and escape any embedded single quotes by closing/reopening.
    local _escaped
    _escaped=$(printf '%s' "$_value" | sed "s/'/'\\\\''/g")
    printf "export %s='%s'\n" "$_name" "$_escaped"
  fi
}

_ls_fail() {
  _ls_log "load-secrets: FATAL: $*"
  # When sourced, do NOT call `exit` — that would kill the user's shell.
  if [ "$_LS_SOURCED" -eq 1 ]; then
    return 1
  fi
  exit 1
}

# -----------------------------------------------------------------------------
# Pre-flight checks.
# -----------------------------------------------------------------------------

_ls_preflight() {
  if ! command -v gcloud >/dev/null 2>&1; then
    _ls_fail "gcloud CLI not found on PATH. Install the Google Cloud SDK and re-run."
    return 1
  fi

  local _active
  _active="$(gcloud auth list --filter=status:ACTIVE --format='value(account)' 2>/dev/null || true)"
  if [ -z "$_active" ]; then
    _ls_fail "No active gcloud account. Run \`gcloud auth login\` first."
    return 1
  fi

  if [ -z "${GCP_PROJECT:-}" ]; then
    GCP_PROJECT="$(gcloud config get-value project 2>/dev/null || true)"
  fi
  if [ -z "$GCP_PROJECT" ] || [ "$GCP_PROJECT" = "(unset)" ]; then
    _ls_fail "GCP project not configured. Run \`gcloud config set project <id>\` or set GCP_PROJECT."
    return 1
  fi

  if [ ! -f "$_LS_MANIFEST" ]; then
    _ls_fail "Manifest not found at $_LS_MANIFEST. (Override with INSTANTML_SECRETS_MANIFEST.)"
    return 1
  fi

  _ls_log "load-secrets: using project=$GCP_PROJECT account=$_active manifest=$_LS_MANIFEST"
  return 0
}

# -----------------------------------------------------------------------------
# Argument parsing.
# -----------------------------------------------------------------------------

_LS_MODE=fetch
for _arg in "$@"; do
  case "$_arg" in
    --check)
      _LS_MODE=check
      ;;
    --help|-h)
      sed -n '2,25p' "$_LS_SCRIPT" >&2
      if [ "$_LS_SOURCED" -eq 1 ]; then return 0; else exit 0; fi
      ;;
    *)
      _ls_log "load-secrets: unknown arg: $_arg"
      if [ "$_LS_SOURCED" -eq 1 ]; then return 2; else exit 2; fi
      ;;
  esac
done

# -----------------------------------------------------------------------------
# Main loop.
# -----------------------------------------------------------------------------

_ls_main() {
  _ls_preflight || return $?

  local _ok=0
  local _missing=0
  local _missing_optional=0

  # Read manifest, skipping comments and blank lines.
  while IFS= read -r _line || [ -n "$_line" ]; do
    # Strip leading whitespace.
    _line="${_line#"${_line%%[![:space:]]*}"}"
    # Skip comments + blanks.
    case "$_line" in
      ''|'#'*) continue ;;
    esac

    # Tokenize: env-var, secret-id, [optional]
    # shellcheck disable=SC2086
    set -- $_line
    local _env_name="${1:-}"
    local _secret_id="${2:-}"
    local _flag="${3:-required}"

    if [ -z "$_env_name" ] || [ -z "$_secret_id" ]; then
      _ls_log "load-secrets: SKIP malformed line: $_line"
      continue
    fi

    if [ "$_LS_MODE" = check ]; then
      if gcloud secrets describe "$_secret_id" --project="$GCP_PROJECT" >/dev/null 2>&1; then
        _ls_log "  OK     $_secret_id (-> $_env_name)"
        _ok=$((_ok + 1))
      else
        if [ "$_flag" = optional ]; then
          _ls_log "  MISS?  $_secret_id (-> $_env_name) [optional]"
          _missing_optional=$((_missing_optional + 1))
        else
          _ls_log "  MISS!  $_secret_id (-> $_env_name) [required]"
          _missing=$((_missing + 1))
        fi
      fi
      continue
    fi

    # fetch mode
    local _value
    if _value=$(gcloud secrets versions access latest \
                   --secret="$_secret_id" \
                   --project="$GCP_PROJECT" 2>/dev/null); then
      _ls_emit_export "$_env_name" "$_value"
      # Scrub the value out of the local var as soon as possible.
      unset _value
      _ls_log "  OK     $_env_name <- $_secret_id"
      _ok=$((_ok + 1))
    else
      if [ "$_flag" = optional ]; then
        _ls_log "  skip   $_env_name <- $_secret_id [optional, not found]"
        _missing_optional=$((_missing_optional + 1))
      else
        _ls_log "  FAIL   $_env_name <- $_secret_id [required, not found]"
        _missing=$((_missing + 1))
      fi
    fi
  done < "$_LS_MANIFEST"

  _ls_log ""
  if [ "$_LS_MODE" = check ]; then
    _ls_log "load-secrets: checked $((_ok + _missing + _missing_optional)) entries — present=$_ok required-missing=$_missing optional-missing=$_missing_optional"
  else
    _ls_log "load-secrets: loaded $_ok secrets — required-missing=$_missing optional-missing=$_missing_optional"
  fi

  if [ "$_missing" -gt 0 ]; then
    _ls_log "load-secrets: $_missing required secret(s) missing from Secret Manager. Fix with \`gcloud secrets create <id>\` + \`gcloud secrets versions add\`. See docs/ops/secrets.md."
    return 1
  fi
  return 0
}

_ls_main
_LS_RC=$?

# Clean up our own scratch vars so we don't pollute the caller's shell.
unset _LS_SOURCED _LS_SCRIPT _LS_TOOLS_DIR _LS_MANIFEST _LS_MODE _arg _line
unset -f _ls_log _ls_emit_export _ls_fail _ls_preflight _ls_main 2>/dev/null

return $_LS_RC 2>/dev/null || exit $_LS_RC
