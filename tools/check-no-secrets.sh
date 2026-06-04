#!/usr/bin/env bash
# check-no-secrets — scan staged files for likely committed secrets.
#
# Wire as a git pre-commit hook:
#     ln -s ../../tools/check-no-secrets.sh .git/hooks/pre-commit
#     chmod +x .git/hooks/pre-commit
#
# Or run ad-hoc on the current diff:
#     tools/check-no-secrets.sh
#
# Exits non-zero (blocking the commit) when a probable secret is found.
# Documented patterns and the suppression comment are listed in
# docs/ops/secrets.md.

set -u

# Allow opting out for genuine emergencies via env var. Document any use.
if [ "${INSTANTML_SKIP_SECRET_SCAN:-0}" = "1" ]; then
  echo "check-no-secrets: INSTANTML_SKIP_SECRET_SCAN=1 — skipping." >&2
  exit 0
fi

# Resolve the set of files we should scan.
# - As a hook: every staged file in the index.
# - Ad hoc: same (we still want to scan only what's about to be committed).
#
# bash 3.2 (the system bash on macOS) lacks `mapfile`, so we walk a temp file.
_LS_STAGED_LIST="$(git diff --cached --name-only --diff-filter=ACMR 2>/dev/null || true)"
if [ -z "$_LS_STAGED_LIST" ]; then
  exit 0
fi

# Patterns. Keep these in sync with docs/ops/secrets.md.
# Each entry: "<pattern>|<human-readable-name>"
_patterns=(
  'sk_live_[A-Za-z0-9]{16,}|Clerk/Stripe live secret key (sk_live_...)'
  'sk_test_[A-Za-z0-9]{16,}|Clerk/Stripe test secret key (sk_test_...)'
  'whsec_[A-Za-z0-9]{16,}|Stripe webhook signing secret (whsec_...)'
  're_live_[A-Za-z0-9]{16,}|Resend live API key (re_live_...)'
  'instantml_[A-Za-z0-9_]{30,}|InstantML-issued API key (instantml_...)'
)

# Password line: KEY=<more than 4 chars that are not obviously a placeholder>.
# We treat empty, `<...>`, `placeholder`, `changeme`, and similar as safe.
_password_keys=(
  'DATABASE_URL'
  'CLICKHOUSE_INSTANTML_GENERAL_KEY_SECRET'
  'CLERK_SECRET_KEY'
  'STRIPE_SECRET_KEY'
  'STRIPE_WEBHOOK_SECRET'
  'RESEND_API_KEY'
  'CLOUDFLARE_R2_API_KEY'
  'CLOUDFLARE_API_TOKEN'
  'CLOUDFLARE_R2_SECRET_ACCESS_KEY'
  'INSTANTML_BOOTSTRAP_TOKEN'
)

_fail=0
# bash 3.2 supports arrays. Use one.
_hits=()

_record_hit() {
  _fail=1
  _hits[${#_hits[@]}]="$1"
}

# Patterns we never want to scan (binaries, lockfiles, vendored stuff).
_skip_file() {
  case "$1" in
    *.lock|package-lock.json|*.png|*.jpg|*.jpeg|*.ico|*.gif|*.pdf|*.zip|*.tar|*.gz)
      return 0 ;;
    tools/check-no-secrets.sh|docs/ops/secrets.md|docs/ops/secrets-inventory.md)
      # The pattern definitions themselves live in these files. They are not
      # secrets, just the descriptors. Skip to avoid self-trips.
      return 0 ;;
    *)
      return 1 ;;
  esac
}

while IFS= read -r _file; do
  [ -z "$_file" ] && continue
  if _skip_file "$_file"; then
    continue
  fi

  # Pull staged content (not the worktree file — the user may have unstaged
  # changes on top).
  if ! _content=$(git show ":$_file" 2>/dev/null); then
    continue
  fi
  if [ -z "$_content" ]; then
    continue
  fi

  # Token patterns.
  for _entry in "${_patterns[@]}"; do
    _pat="${_entry%%|*}"
    _name="${_entry#*|}"
    while IFS= read -r _line; do
      _record_hit "  $_file: $_name  ->  $_line"
    done < <(
      printf '%s' "$_content" \
        | grep -nE "$_pat" \
        | grep -vE 'allow-secret-pattern' \
        | head -3
    )
  done

  # Password-shaped assignment patterns.
  for _key in "${_password_keys[@]}"; do
    while IFS= read -r _match; do
      # _match format: "<line-no>:<full-line>"
      _lineno="${_match%%:*}"
      _line="${_match#*:}"
      # Trim leading spaces.
      _rhs="${_line#*=}"
      # Strip trailing comment if any.
      _rhs_noc="${_rhs%%#*}"
      # Strip surrounding quotes.
      _rhs_noc="${_rhs_noc#\"}"
      _rhs_noc="${_rhs_noc%\"}"
      _rhs_noc="${_rhs_noc#\'}"
      _rhs_noc="${_rhs_noc%\'}"
      # Strip whitespace.
      _rhs_trim="$(printf '%s' "$_rhs_noc" | tr -d '[:space:]')"
      # Allow placeholders and empty values.
      case "$_rhs_trim" in
        ''|'<'*'>'|'PLACEHOLDER'*|'placeholder'*|'changeme'*|'CHANGEME'*|'redacted'*|'REDACTED'*|'TODO'*|'todo'*)
          continue ;;
      esac
      # Allow a "load from Secret Manager" comment on the same line.
      case "$_line" in
        *'load from Secret Manager'*) continue ;;
        *'allow-secret-pattern'*) continue ;;
      esac
      # Allow short values (4 chars or fewer) since real secrets are longer.
      if [ "${#_rhs_trim}" -le 4 ]; then
        continue
      fi
      _record_hit "  $_file:$_lineno: $_key has a non-placeholder value"
    done < <(printf '%s' "$_content" | grep -nE "^[[:space:]]*${_key}=" || true)
  done
done <<EOF
$_LS_STAGED_LIST
EOF

if [ "$_fail" -ne 0 ]; then
  echo "" >&2
  echo "check-no-secrets: refusing to commit — potential secrets found:" >&2
  _i=0
  while [ $_i -lt ${#_hits[@]} ]; do
    echo "${_hits[$_i]}" >&2
    _i=$((_i + 1))
  done
  echo "" >&2
  echo "If this is a false positive, append \`# allow-secret-pattern: <reason>\` to the line, or set INSTANTML_SKIP_SECRET_SCAN=1 for one commit." >&2
  echo "See docs/ops/secrets.md for the pattern list and the right place to put secrets." >&2
  exit 1
fi

exit 0
