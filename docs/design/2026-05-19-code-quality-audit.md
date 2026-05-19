# Code Quality Audit — 2026-05-19

Senior-engineer pass across Rust server, TypeScript/React web app, and Python SDK.

---

## 1. File-size outliers

| File | Lines | Rationale |
|------|-------|-----------|
| `apps/web/app/dashboard-components.tsx` | 3946 | **Split candidate.** Single file exports ~40 distinct components (charts, nav, compare view, artifact browser, modals, table). Easily 8-10 cohesive modules. |
| `apps/web/app/dashboard/dashboard-shell.tsx` | 3147 | **Split candidate.** Single component manages entire dashboard: auth, data fetching, all tab rendering, keyboard shortcuts, workspace undo/redo. God component. |
| `apps/rust-server/src/http/handlers.rs` | 2440 | Large, but ~900 lines are the `openapi_json` function (justified verbosity — declarative API spec). Remaining handlers are thin wrappers, each ~5-20 lines. Acceptable. |
| `packages/python-sdk/instantml/client.py` | 2117 | Contains SDK classes, rich-object types, framework adapters (Transformers, Lightning), and ~600 lines of private helpers. Splitting into `_rich_objects.py`, `_adapters.py`, `_helpers.py` would help readability. |
| `apps/rust-server/src/store/runs.rs` | 1418 | Contains all run CRUD + metric operations. Borderline acceptable given domain cohesion. |
| `apps/rust-server/src/store/auth.rs` | 1411 | Contains all auth/session/org flows. Cohesive but large. |

---

## 2. Function-size outliers

| Function | File:Line | Lines | Justified? |
|----------|-----------|-------|-----------|
| `openapi_json` | `handlers.rs:29` | ~900 | Yes — declarative JSON spec. Mechanical repetition, not logic. |
| `DashboardShell` | `dashboard-shell.tsx:283` | ~2800 | No — the entire dashboard lives in one React component function with 80+ `useState` calls, 30+ `useEffect`/`useMemo`/`useCallback` hooks, and all tab-rendering inline. Needs to be broken up. |
| `Run.__init__` + `Run` class | `client.py:446` | ~700 | Borderline. The class is cohesive but long. Could extract console-capture and system-metrics into standalone classes (already partially done). |
| `create_verified_provider_session` | `store/auth.rs` | ~100 | Acceptable; sequential business steps. |

---

## 3. Duplication hotspots

**`"eval/return_mean"` default metric string** — used as a bare literal in 5 places in `dashboard-shell.tsx` (lines 308, 320, 402, 1570, 1580) and once in `src/state.js:115`. A `DEFAULT_METRIC_KEY` constant extracted in `dashboard-models.ts` would close this.

**`Image`, `Video`, `Audio` constructor pattern** — all three classes in `client.py` share an identical `path`/`data` mutual-exclusion guard and a `from_data` classmethod. ~30 lines of copy-pasted logic. Could be a shared `_MediaObject` base class, but only 3 callers — borderline for extraction.

**`_validate_text` 512-byte guard** — the 512-byte limit appears as a bare `512` in both `_validate_note_text` (line 1570) and `_validate_text` (line 1698). Already has a module-level `MAX_CONSOLE_LOG_MESSAGE_BYTES` constant pattern; a `MAX_TEXT_BYTES = 512` would match it.

**`context()` comment duplication** — the Tier-2 architecture comment at `handlers.rs:1930-1934` is paraphrased again at line 2017-2018. One of them is redundant.

**`compareSearchTokens` vs inline tokenization** — `dashboard-components.tsx:3593` defines the function; `dashboard-shell.tsx:704` inlines the same `.trim().toLowerCase().split(/\s+/).filter(Boolean)` split. Should call the imported function (it's not imported, so the function is either re-implemented or the module boundary is wrong).

---

## 4. Comment audit — restating-what-code-does (worst examples)

These comments describe what the adjacent code already says clearly:

| # | File:Line | Comment (paraphrased) | Verdict |
|---|-----------|----------------------|---------|
| 1 | `store/device_code.rs:36` | "Sample 8 bytes of randomness via two UUIDs (we only need 8 bytes)." | Restates the `Uuid::new_v4().as_bytes()[..8]` on the next line. **Delete.** |
| 2 | `store/device_code.rs:88` | "Eagerly evict expired codes to keep the map bounded." | Restates `data.evict_expired_device_codes(now)`. **Delete.** |
| 3 | `store/device_code.rs:115` | "Expiry check." | One-word label above an obvious `if expires_at < now` block. **Delete.** |
| 4 | `store/device_code.rs:121` | "Rate-limit: enforce polling interval." | Labels the if-block that follows. **Delete.** |
| 5 | `store/device_code.rs:139` | "Return plaintext exactly once, then consume the record." | Restates the take-plaintext code. **Delete.** |
| 6 | `store/device_code.rs:145` | "Mark consumed so re-polls see 'expired'." | Restates `status = "expired"` assignment. **Delete.** |
| 7 | `store/device_code.rs:190` | "Normalize the user code: uppercase, with hyphen for lookup." | Restates a `.to_uppercase()` call. **Delete.** |
| 8 | `store/device_code.rs:221` | "Ensure the tenant route is live before minting the key." | Restates `ensure_tenant_loaded` call. **Delete.** |
| 9 | `store/device_code.rs:224` | "Mint the API key." | Labels a `create_api_key` call. **Delete.** |
| 10 | `store/device_code.rs:265` | "Update in-memory state and device code record atomically." | Restates what the next 10 lines obviously do. **Delete.** |
| 11 | `store/auth.rs:361` | "Resolve org name: use explicit org_name if provided, else auto-derive." | Restates the `match org_name` branch. **Delete.** |
| 12 | `store/auth.rs:383` | "Route personal/free orgs to the shared cell; business orgs get dedicated." | Restates the `if is_personal_account_type` check. **Delete.** |
| 13 | `store/auth.rs:434` | "Atomically mint an onboarding SDK key for the new org." | Restates `create_api_key` call. **Delete.** |
| 14 | `store/tenants.rs:325` | "Build a route record that describes the shared cell." | Labels an obvious struct initialization. **Delete.** |
| 15 | `client.py:1172` | `return  # explicit kwarg provided — skip resolution check` | The `if api_key: return` is self-documenting. **Delete inline comment.** |

**Legitimate comments to keep:** The Tier-2 architecture block in `handlers.rs:1930-1934`, the cookie `Secure`-on-loopback heuristic in `handlers.rs:2068-2072`, the `_resolve_api_key` docstring (priority chain is non-obvious), `wait_for_init` docstring (explains the timeout contract), the unix-epoch sentinel comment in `control_store.rs:95-96`, and all animation/design comments in the landing components.

---

## 5. Dead code candidates

**`_check_credentials_or_raise`** in `client.py:1164` — its docstring says "Only raises when..." but the function never raises; it only `warnings.warn`. The function name is misleading. Additionally, searching the file shows it is never called. If unused, delete it.

**`PlanUsageBadge`** in `dashboard-components.tsx:845` — defined but not exported and usage is only within that file. Verify it's actually rendered somewhere; if not, delete.

**`WorkspaceMode`** type in `dashboard-types.ts:216` — exported but never referenced from the grep. Check before removing.

---

## 6. Magic-value hotspots

| Value | File | Occurrences | Fix |
|-------|------|-------------|-----|
| `"eval/return_mean"` | `dashboard-shell.tsx` | 5 | Extract `DEFAULT_METRIC_KEY` in `dashboard-models.ts` (the constant already lives adjacent to `PREFERRED_AUTOMATIC_METRICS`). |
| `512` (byte limit for text/notes) | `client.py:1570,1698` | 2 | Add `MAX_TEXT_BYTES = 512` constant alongside the existing `MAX_CONSOLE_LOG_MESSAGE_BYTES`. |
| `60 * 60 * 24 * 30` (session cookie TTL) | `handlers.rs:2056` | 1 | Add `const SESSION_COOKIE_MAX_AGE_SECS: u64 = 60 * 60 * 24 * 30;` in `http/mod.rs`. |
| `24` (quick search result cap) | `dashboard-shell.tsx:711` | 1 | Low priority — single site, meaning is clear. |
| `30` (compact rail name max) | `dashboard-components.tsx:125` | 1 | Low priority — single site. |

---

## 7. `unwrap`/`expect`/`!` non-test uses

All bare `unwrap()` calls in the Rust codebase are in `#[cfg(test)]` blocks **except** the following production-path uses:

| File:Line | Code | Risk |
|-----------|------|------|
| `store/device_code.rs:44-45` | `std::str::from_utf8(&chars[..]).unwrap()` | Zero risk — alphabet is ASCII constants, UTF-8 conversion cannot fail. Could use `SAFETY` comment. |
| `handlers.rs:2355` (test helper) | `"127.0.0.1:0".parse().unwrap()` | Test-only helper struct — acceptable. |

The `unwrap_or`, `unwrap_or_else`, `unwrap_or_default` calls throughout are all appropriate fallback patterns, not panic risk.

**Python:** One `assert self.run is not None` at `client.py:1520` in `TransformersCallback.on_log` — the guard `if self.run is None: self.setup(...)` immediately above should make this invariant provable but the assert is technically a runtime panic in production trainer loops if `setup()` silently fails. Low risk in practice.

---

## 8. Recommended cleanup queue

Priority ordering: high confidence → judgment-required → skip.

### Do now (safe, high-confidence)

1. **Delete restating-comments in `store/device_code.rs`** — 10 comments identified above. Low risk, clean signal. (~10 lines deleted)
2. **Delete restating-comments in `store/auth.rs`** — 3 comments identified above. (~5 lines)
3. **Delete restating-comments in `store/tenants.rs`** — 2 comments. (~3 lines)
4. **Add `DEFAULT_METRIC_KEY` constant** in `dashboard-models.ts` and replace the 5 bare `"eval/return_mean"` literals in `dashboard-shell.tsx`. Zero behavior change. (~6 lines changed)
5. **Add `MAX_TEXT_BYTES = 512`** in `client.py` and replace the 2 bare `512` literals. (~3 lines)
6. **Delete `_check_credentials_or_raise`** if it is truly unreferenced (confirm first — grep shows no call sites in SDK code). (~30 lines)
7. **Add `SESSION_COOKIE_MAX_AGE_SECS` constant** in `http/mod.rs` and reference it in `session_cookie_header`. (~3 lines)

### Do soon (low-risk but requires reading)

8. **Remove duplicate Tier-2 architecture comment** at `handlers.rs:2017-2018` (shorter version; keep the full one at 1930-1934). (~2 lines)
9. **Remove inline comments on `return` statements** in `_check_credentials_or_raise` (lines 1172, 1174, 1178). Self-documenting code.
10. **`_resolve_api_key` docstring** — item 4 says "Always raise InstantMLError" but the function returns `None`. Fix the docstring to match reality. (~2 lines)

### Judgment-required (don't touch in this pass)

- **Splitting `dashboard-components.tsx` and `dashboard-shell.tsx`** — these are the highest-leverage structural changes but carry real risk: import graph changes, potential SSR/client boundary issues, and requires coordinating with in-flight UI work. Needs a dedicated PR with proper testing.
- **Extracting `_MediaObject` base class** for `Image`/`Video`/`Audio` in `client.py` — only 3 callers, abstraction not yet earning its keep.
- **`DashboardShell` god-component decomposition** — same as above; extracting state and effects into custom hooks would be valuable but is non-trivial.
- **`openapi_json` refactor** — it's legitimately mechanical. Worth generating it from route metadata eventually, but not a quick win.
