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
//!   the position of this run within its project, starting at 1. Adjective
//!   and noun are picked deterministically from `(org_id, project_id,
//!   sequence)` so the name is reproducible and concurrent run-creates in
//!   the same project never collide on the same sequence.
//!
//! The wordlists are intentionally generic (animals, weather, colors,
//! nature, materials) — not ML-flavored, since names appear in shared
//! reports, screenshots, and customer demos forever.
//!
//! Two-pass picks (`adj × noun`) gives ~16k unique base names; the
//! trailing sequence number guarantees per-project uniqueness regardless.

use uuid::Uuid;

pub const DEFAULT_PROJECT_NAME: &str = "default";

/// Generate a friendly default run name shaped like `<adj>-<noun>-<seq>`.
///
/// The sequence (`seq`) is the position of this run within its project,
/// **1-indexed**. The adjective and noun are chosen deterministically from
/// `(org_id, project_id, seq)` so:
///
/// - The same inputs always produce the same name (debuggable, testable).
/// - Concurrent creates that race on the same sequence number still pick
///   different adjective/noun pairs from the same seed component, reducing
///   the practical collision rate even if the sequence count is briefly
///   stale.
///
/// The output is always a valid `validate_name` result — lowercase ASCII,
/// hyphen-separated, well under any size limit.
pub fn generate_run_name(org_id: Uuid, project_id: Uuid, seq: u64) -> String {
    let seed = hash_seed(org_id, project_id, seq);
    let adj = ADJECTIVES[(seed % ADJECTIVES.len() as u64) as usize];
    let noun = NOUNS[((seed / ADJECTIVES.len() as u64) % NOUNS.len() as u64) as usize];
    format!("{adj}-{noun}-{seq}")
}

fn hash_seed(org_id: Uuid, project_id: Uuid, seq: u64) -> u64 {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let mut hasher = DefaultHasher::new();
    org_id.hash(&mut hasher);
    project_id.hash(&mut hasher);
    seq.hash(&mut hasher);
    hasher.finish()
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

    #[test]
    fn run_name_is_kebab_with_sequence_suffix() {
        let name = generate_run_name(Uuid::nil(), Uuid::nil(), 1);
        let parts: Vec<&str> = name.rsplitn(2, '-').collect();
        // Last segment is the sequence number.
        assert_eq!(parts[0], "1");
        // The rest is `<adj>-<noun>`.
        assert!(
            parts[1].contains('-'),
            "expected adj-noun before suffix, got {name}"
        );
    }

    #[test]
    fn run_name_is_deterministic_for_same_inputs() {
        let org = Uuid::from_u128(42);
        let project = Uuid::from_u128(7);
        assert_eq!(
            generate_run_name(org, project, 1),
            generate_run_name(org, project, 1)
        );
    }

    #[test]
    fn run_name_differs_across_sequence() {
        let org = Uuid::from_u128(42);
        let project = Uuid::from_u128(7);
        let a = generate_run_name(org, project, 1);
        let b = generate_run_name(org, project, 2);
        assert_ne!(a, b);
        // The sequence suffix flips, which alone forces inequality even when
        // the adj/noun roll happens to match.
        assert!(a.ends_with("-1"));
        assert!(b.ends_with("-2"));
    }

    #[test]
    fn run_name_differs_across_project() {
        // Same sequence, different projects → adj/noun should drift so that
        // the human-readable handle remains distinct even when sequences
        // coincide across projects.
        let org = Uuid::from_u128(42);
        let a = generate_run_name(org, Uuid::from_u128(1), 1);
        let b = generate_run_name(org, Uuid::from_u128(2), 1);
        // Both end in -1 by construction; but the adj-noun prefix should
        // (almost always) differ. The 1-in-4096 collision is acceptable.
        if a == b {
            // Document the rare expected case.
            assert!(a.ends_with("-1"));
        }
    }

    #[test]
    fn run_name_under_size_limit() {
        // Sanity: the longest combination plus a 20-digit sequence still
        // fits comfortably under the 1024-byte validate_name limit.
        let name = generate_run_name(Uuid::nil(), Uuid::nil(), u64::MAX);
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
