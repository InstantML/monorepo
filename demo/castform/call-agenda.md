# Castform Call Agenda

## Suggested 30-Minute Structure

1. Introductions and goals, 3 minutes.
   Confirm whether the call is about co-selling, product integration, customer
   workflow, or technical feasibility.

2. Castform workflow recap, 5 minutes.
   Ask them to describe how users launch runs, monitor training, pick
   checkpoints, and compare candidates today.

3. InstantML demo, 12 minutes.
   Show Castform-shaped runs in InstantML: run search, comparison charts,
   reward/eval failure modes, logs/evidence, and export/agent analysis.

4. Integration discussion, 7 minutes.
   Walk through pull sync now, webhooks/observer later, and possible embedded
   panels or shared reports.

5. Next steps, 3 minutes.
   Agree on a sandbox run/key, API stability expectations, and who owns the
   first prototype.

## Discovery Questions

- How many training runs does a typical Castform customer compare before
  selecting a model or checkpoint?
- Do users compare across datasets, reward versions, models, or mostly training
  hyperparameters?
- Where do users currently lose time: launch setup, reward debugging, run
  comparison, model selection, exporting evidence, or collaboration?
- What metrics and rollout details do users ask support about most often?
- Are reward components and eval results standardized enough to mirror with a
  default schema?
- Do users need historical export for compliance, customer handoff, or internal
  research notes?
- Do larger customers want observability in their own data plane?
- Would Castform prefer a "push metrics to InstantML" integration, an InstantML
  pull connector, or an embedded InstantML panel?

## Technical Questions

- Which Castform APIs are stable for partner consumption today?
- Are there rate limits or pagination limits on run scalar and log reads?
- Can a read-only org token access multiple runs without user session coupling?
- Are run events enough to discover checkpoint/eval/model artifact references?
- Can metric batches include source timestamps and idempotency IDs?
- Can Castform sign webhooks or provide a service-account token?
- What data should never leave Castform, even into a customer-selected
  observability destination?

## Proposed Next Step

Request one of:

- a read-only sandbox API key plus 3-5 non-sensitive run IDs;
- exported scalar/log JSON for 3-5 runs;
- a shared call where they screen-share a representative run and confirm which
  signals should be mirrored.

Then return with a real mirrored InstantML workspace and a short integration
proposal.
