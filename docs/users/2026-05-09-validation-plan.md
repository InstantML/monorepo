# Validation Plan: W&B-Style InstantML

Date: 2026-05-09

Status: Ready for outreach; no live interviews recorded yet

## Purpose

Validate whether small ML teams, labs, and lean platform groups care enough about speed, UI quality, predictable pricing, and data portability to try InstantML beside or instead of W&B, MLflow, Neptune, TensorBoard, or custom logging.

## Evidence Status

- No real customer interviews are recorded in this repository.
- No pricing interviews are recorded in this repository.
- Product and pricing claims remain hypotheses until outreach notes are added here or in a dated raw-notes file.
- Do not mark validation complete in `TODO.md` until at least five relevant teams have been interviewed and synthesized.

## Who To Interview

Prioritize people who recently compared, paid for, migrated from, or complained about an experiment tracker:

- Research engineers at 2-20 person AI startups.
- ML leads at university or independent research labs.
- ML platform engineers at small companies using W&B or MLflow.
- Fine-tuning teams running many small/medium experiments.
- Robotics, RL, or simulation teams comparing many seeds and checkpoints.
- Open-source model maintainers with public benchmark runs.

## Minimum Validation Bar

Positioning validation is credible only after:

- At least 8 discovery calls.
- At least 5 teams already using W&B, MLflow, Neptune, TensorBoard, or a custom tracker.
- At least 3 teams with budget influence or direct pricing sensitivity.
- At least 3 teams willing to try import or dual logging on a real project.

Pricing validation is credible only after:

- At least 5 pricing conversations with team size, storage, run volume, and current tool cost ranges.
- At least 3 teams respond to concrete Free/Pro/Premium tier drafts.
- At least 2 teams say what would trigger upgrade, churn, or self-host/VPC need.

## Interview Script

Keep the first half about their workflow, not this product.

1. What do you use for experiment tracking today?
2. What breaks when comparing many runs, configs, checkpoints, metrics, or artifacts?
3. When does the UI feel slow or confusing?
4. How often do tracker costs surprise or constrain the team?
5. What data must remain portable or exportable?
6. What would make you dual-log to evaluate a replacement?
7. What would make you switch for one real project?
8. What would make you trust it for important runs?
9. Would a hosted Rust/ClickHouse backend with exportable schemas, API keys, and future self-host/VPC options feel trustworthy enough for your team?

Then test the wedge:

```text
I am building InstantML for smaller ML teams that want W&B-like experiment tracking, but faster for daily run comparison, calmer in the UI, and priced predictably around seats plus included storage rather than tracked hours.

What part of that sounds useful, wrong, or irrelevant for your team?
```

## Pricing Questions

Use ranges, not leading yes/no questions:

1. How many people need full access to runs and artifacts?
2. How much metric history and artifact storage do you create in a typical month?
3. Do tracked hours, seats, storage, or compute feel most fair as billing units?
4. Which tier would you expect your team to start on?
5. What monthly price would feel obvious, acceptable, expensive, and impossible?
6. Would storage overage at `$0.02-$0.03/GiB-month` feel understandable?
7. Should metric/event volume be a hard limit, fair-use warning, or upgrade prompt?
8. What would make self-hosting, VPC, SSO, or audit logs necessary?
9. Would seat-plus-included-storage pricing feel more predictable than tracked-hour billing for your workload?

## Scorecard

Record each call with:

| Field | Notes |
| --- | --- |
| Team type | Startup, lab, platform, open source, other |
| Current tracker | W&B, MLflow, Neptune, TensorBoard, custom, none |
| Team size | Number of likely seats |
| Monthly storage | Estimate or current bill |
| Pain severity | 1-5 |
| Speed pain | 1-5 |
| UI pain | 1-5 |
| Pricing pain | 1-5 |
| Data-control pain | 1-5 |
| Hosted-backend trust | 1-5 |
| Willing to import | yes/no/maybe |
| Willing to dual-log | yes/no/maybe |
| Likely tier | Free/Pro/Premium/Enterprise |
| Quote | Short anonymized quote |
| Follow-up | Concrete next step |

## Decision Rules

- If teams care mostly about broad MLOps features, narrow the wedge before building more surface area.
- If teams like the wedge but will not import or dual-log, prioritize integration ergonomics before UI breadth.
- If pricing pain is weak, compete on speed and UI first, and keep pricing simple but not deeply discounted.
- If data-control pain is strong, prioritize export, self-host/VPC planning, and transparent schemas.
- If small teams reject seat pricing, revisit included-seat bundles before public launch.

## Raw Notes Policy

Store raw notes in dated files under `docs/users/`, anonymize private details, and separate direct quotes from synthesis. Do not add names, emails, customer secrets, proprietary model details, or sensitive billing details unless the repository is explicitly approved for that data.
