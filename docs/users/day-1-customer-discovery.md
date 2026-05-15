# Day 1: Customer Discovery Plan and Wedge Hypotheses

Date: 2026-05-05

Status: Planning artifact, not completed user research

## Goal

Prepare to validate the first wedge for InstantML:

> A focused W&B-style training observability product for teams that need faster run comparison, reliable ingestion, artifact/source visibility, and more control over experiment history.

## Hypothesized ICP

Primary user:

- Research engineer or ML infrastructure owner at a small AI lab, model fine-tuning team, robotics team, simulation team, or ML platform group.

Hypothesized pain:

- Hard to compare many stochastic runs and seeds.
- Hard to tie metrics to configs, checkpoints, and rollout behavior.
- Existing tools feel too expensive, too closed, too broad, or too clunky at high run counts.
- Sensitive research metadata makes SaaS uncomfortable.

Hypothesized buying trigger:

- Replacing, augmenting, or dual-logging beside W&B.
- Evaluating W&B cost, lock-in, data-control, or workflow concerns.
- Using MLflow but unhappy with comparison UX.
- Leaving or de-risking Neptune usage.
- Starting a new training project and wanting portable tracking from day one.

## Candidate User Segments To Validate

1. W&B users with cost, privacy, control, or UI pain.
2. MLflow users with comparison and artifact-browser pain.
3. Small AI labs training or fine-tuning models.
4. ML platform engineers at startups.
5. Open-source model maintainers with public benchmark runs.
6. Research engineers comparing many model variants.
7. Evaluation teams comparing checkpoints and prompts after fine-tuning.
8. Former or evaluating Neptune users.
9. Robotics startups.
10. Simulation-heavy autonomy teams.
11. Independent RL researchers.
12. University RL labs.
13. JAX/Flax research teams.
14. PyTorch training teams.
15. Stable-Baselines users.
16. Ray/RLlib users.
17. Offline RL researchers.
18. Sim2real robotics teams.
19. Hardware-constrained teams tracking wasted runs.
20. Public leaderboard maintainers.

## Outreach Targets To Identify

Find 20 specific people or teams from:

- W&B users discussing pricing, privacy, export, or lock-in concerns.
- MLflow users discussing UI and comparison limitations.
- Open-source fine-tuning repos with many experiment configs.
- Robotics simulation repos.
- Recent RL papers with open-source repos.
- Stable-Baselines, RLlib, CleanRL, and Gymnasium communities.
- Neptune migration discussions.

## Contact Plan

Contact 10 people with a short, concrete ask:

```text
Hey <name>, I am building a training observability tool for teams that use W&B, MLflow, Neptune, TensorBoard, or custom logging.

I am trying to understand where experiment tracking breaks down when comparing many runs, configs, checkpoints, artifacts, or evaluations.

Could I ask you 5-6 questions? No pitch, just trying to map the pain accurately.
```

## Interview Questions

1. What do you use today for experiment tracking?
2. What breaks or gets annoying when you compare many runs, configs, checkpoints, or evals?
3. Do you need self-hosting, local-first logging, data residency, export, or backend control?
4. How do you connect metrics to configs, checkpoints, artifacts, and rollout behavior?
5. Have you ever migrated between trackers? What was painful?
6. Which is worse for you: missing features, slow UX, cost, lock-in, or setup friction?
7. What would make you try a new tracker for one project?
8. What would make you trust it enough for serious runs?
9. Would you dual-log to evaluate a new tracker? Why or why not?

## Assumptions To Validate

- Teams care more about fast comparison, artifacts, source context, and trust than broad MLOps surface area.
- W&B users may dual-log before switching.
- MLflow users are open to a better UI if data remains portable.
- Migration from existing trackers is a strong adoption hook, but not a durable product by itself.
- RL teams care more about seed comparison and rollout inspection than generic dashboarding.

## First Workflow Decision For Bootstrap Implementation

The first example workflow was an RL-style training loop with deterministic fake CartPole-like metrics. It avoided simulator dependencies while proving the logging shape:

1. Start local API.
2. Run example training script.
3. SDK creates a project/run.
4. SDK logs scalar metrics by step.
5. SDK finishes the run.
6. API returns run and bounded metric history.

After bootstrap, dogfood coverage expanded to Q-learning gridworld, contextual bandit, and supervised regression examples. Real simulator integrations should still wait until the SDK/API/storage path is stable enough for external users.

## Research Status

Created as planning artifacts:

- Hypothesized ICP.
- Candidate segments to validate.
- Outreach draft.
- Interview question draft.
- Bootstrap workflow decision.

No interview notes, contacted-user lists, or validated customer findings are recorded in this file.

Current priority from `PRODUCT_STRATEGY.md`: before broadening the feature set, validate the W&B-competitor training observability wedge with real teams. Treat ICP, segment, and outreach content here as hypotheses, not evidence.
