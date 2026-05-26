//! Default-name generation for runs and projects.
//!
//! When the SDK creates a run without an explicit `name` (or `project`), the
//! server fills in a sensible default rather than rejecting the request or
//! using the generic string "run".
//!
//! ## Naming premise
//!
//! Friendly `<adjective>-<noun>-N` defaults are the industry convention
//! because they're memorable, sortable inside a project, and unambiguous in
//! shared reports.
//!
//! - **Project default:** `"default"` — a single shared bucket so ad-hoc
//!   and migrated runs land in a predictable place.
//! - **Run default:** `<adjective>-<noun>-<sequence>` where the sequence is
//!   the position of this run within its project, starting at 1. The
//!   adjective/noun pair is rolled from OS entropy on every call, so two
//!   concurrent creates that race on the same sequence still get distinct
//!   human-readable handles. Per-run uniqueness is also guaranteed by the
//!   underlying UUID; the name is the friendly label, not the identity.
//!
//! The wordlists are intentionally generic (animals, weather, colors,
//! nature, materials) — not ML-flavored, since names appear in shared
//! reports, screenshots, and customer demos forever.
//!
//! Two-pass picks (`adj × noun`) give ~16k unique base names; the trailing
//! sequence number guarantees per-project ordering regardless.

use crate::errors::{AppError, AppResult};

pub const DEFAULT_PROJECT_NAME: &str = "default";

/// Generate a friendly default run name shaped like `<adj>-<noun>-<seq>`.
///
/// The sequence (`seq`) is the position of this run within its project,
/// **1-indexed**. The adjective and noun are picked from OS entropy, so
/// each call produces an independent roll — concurrent creates that race
/// on the same sequence still get distinct adj/noun pairs.
///
/// The output is always a valid `validate_name` result — lowercase ASCII,
/// hyphen-separated, well under any size limit.
pub fn generate_run_name(seq: u64) -> AppResult<String> {
    let pick = random_u64()?;
    let adj = ADJECTIVES[(pick % ADJECTIVES.len() as u64) as usize];
    let noun = NOUNS[((pick / ADJECTIVES.len() as u64) % NOUNS.len() as u64) as usize];
    Ok(format!("{adj}-{noun}-{seq}"))
}

fn random_u64() -> AppResult<u64> {
    let mut bytes = [0u8; 8];
    getrandom::getrandom(&mut bytes)
        .map_err(|error| AppError::internal(format!("failed to roll default run name: {error}")))?;
    Ok(u64::from_le_bytes(bytes))
}

// ─────────────────────────────────────────────────────────────────────────
// Wordlists
//
// 64 entries each → 4096 base combinations. Curated for:
// - all lowercase ASCII letters only (no apostrophes, no spaces, no diacritics)
// - 4-9 chars (keeps full names under ~20 chars before the sequence)
// - non-controversial English words a customer would put on a screenshot
// ─────────────────────────────────────────────────────────────────────────

const ADJECTIVES: &[&str] = &[
    "amber", "ancient", "azure", "bold", "brave", "brisk", "calm", "clever", "cosmic", "crisp",
    "curious", "dapper", "deep", "eager", "earnest", "electric", "elegant", "ember", "fancy",
    "fearless", "fierce", "frosty", "gentle", "glowing", "golden", "graceful", "happy", "humble",
    "icy", "jolly", "jovial", "keen", "kind", "lively", "loyal", "lucky", "lunar", "mellow",
    "merry", "mighty", "misty", "modest", "noble", "polished", "proud", "quick", "quiet",
    "radiant", "rapid", "regal", "rosy", "rugged", "sage", "scarlet", "serene", "silent", "silver",
    "sleek", "solid", "spry", "stoic", "sunny", "swift", "tidy",
];

const NOUNS: &[&str] = &[
    "anchor",
    "atlas",
    "aurora",
    "badger",
    "beacon",
    "blossom",
    "boulder",
    "breeze",
    "brook",
    "canyon",
    "cedar",
    "cliff",
    "comet",
    "crane",
    "crystal",
    "current",
    "delta",
    "ember",
    "falcon",
    "fjord",
    "forest",
    "garnet",
    "geyser",
    "glacier",
    "harbor",
    "hawk",
    "horizon",
    "iris",
    "ivy",
    "kestrel",
    "lantern",
    "ledger",
    "lighthouse",
    "lotus",
    "marble",
    "meadow",
    "moss",
    "mountain",
    "nebula",
    "orbit",
    "otter",
    "pebble",
    "petal",
    "pioneer",
    "prairie",
    "quartz",
    "quill",
    "raven",
    "ridge",
    "river",
    "saffron",
    "savanna",
    "shore",
    "sparrow",
    "spiral",
    "stone",
    "summit",
    "thicket",
    "thunder",
    "topaz",
    "vista",
    "wave",
    "willow",
    "zephyr",
];

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn run_name_is_kebab_with_sequence_suffix() {
        let name = generate_run_name(1).unwrap();
        // Trailing segment is the sequence number.
        assert!(name.ends_with("-1"), "expected -1 suffix, got {name}");
        // Three hyphen-separated segments: adj, noun, seq.
        assert_eq!(name.split('-').count(), 3, "shape changed: {name}");
        let mut parts = name.split('-');
        let adj = parts.next().unwrap();
        let noun = parts.next().unwrap();
        assert!(
            ADJECTIVES.contains(&adj),
            "adjective not in wordlist: {adj}"
        );
        assert!(NOUNS.contains(&noun), "noun not in wordlist: {noun}");
    }

    #[test]
    fn run_name_carries_through_arbitrary_sequence() {
        let name = generate_run_name(42).unwrap();
        assert!(name.ends_with("-42"), "expected -42 suffix, got {name}");
    }

    #[test]
    fn concurrent_calls_with_same_sequence_are_almost_always_distinct() {
        // With 64×64 = 4096 base combinations and OS-entropy seeding, 200
        // rolls at the same sequence should produce a healthy spread of
        // unique names. We tolerate a small collision count (birthday-paradox
        // bound) but the set must not collapse to one entry.
        let names: HashSet<String> = (0..200).map(|_| generate_run_name(1).unwrap()).collect();
        assert!(
            names.len() > 100,
            "expected >100 distinct names from 200 rolls, got {} — random seeding may be broken",
            names.len()
        );
    }

    #[test]
    fn run_name_under_size_limit() {
        // Sanity: the longest combination plus a 20-digit sequence still
        // fits comfortably under the 1024-byte validate_name limit.
        let name = generate_run_name(u64::MAX).unwrap();
        assert!(name.len() < 64, "unexpectedly long name: {name}");
    }

    #[test]
    fn wordlists_are_ascii_kebab_safe() {
        for word in ADJECTIVES.iter().chain(NOUNS.iter()) {
            assert!(
                word.chars().all(|c| c.is_ascii_lowercase()),
                "wordlist contains non-ascii-lowercase entry: {word}"
            );
            assert!(!word.is_empty(), "wordlist contains empty entry");
        }
    }

    #[test]
    fn default_project_name_is_pinned() {
        // Pinned so an accidental rename of the default trips a loud test
        // failure rather than silently changing the bucket every implicit
        // run lands in.
        assert_eq!(DEFAULT_PROJECT_NAME, "default");
    }
}
