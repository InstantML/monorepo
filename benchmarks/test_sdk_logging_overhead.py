import unittest
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
import sdk_logging_overhead as bench


class SdkLoggingOverheadTests(unittest.TestCase):
    def test_metric_payload_is_deterministic_and_sized(self):
        payload = bench.metric_payload(3, 8)

        self.assertEqual(len(payload), 8)
        self.assertIn("eval/return_mean", payload)
        self.assertIn("custom/metric_08", payload)
        self.assertEqual(payload, bench.metric_payload(3, 8))

    def test_sample_plan_interleaves_cases_deterministically(self):
        plan = bench.sample_plan(["noop", "instantml-spool-durable", "wandb-offline"], 2, 42)

        self.assertEqual(len(plan), 6)
        self.assertEqual([sample for sample, _case in plan[:3]], [0, 0, 0])
        self.assertEqual([sample for sample, _case in plan[3:]], [1, 1, 1])
        self.assertEqual(plan, bench.sample_plan(["noop", "instantml-spool-durable", "wandb-offline"], 2, 42))

    def test_summarize_values_uses_nearest_rank_p95(self):
        summary = bench.summarize_values([1, 2, 3, 4, 5])

        self.assertEqual(summary["median"], 3)
        self.assertEqual(summary["p95"], 5)

    def test_summarize_results_reports_noop_overhead(self):
        payload = {
            "samples": [
                sample("noop", 10, 8),
                sample("instantml-spool-durable", 40, 20),
            ],
        }

        summaries = bench.summarize_results(payload)

        self.assertEqual(summaries["noop"]["tree_cpu_us_per_log"]["median"], 10)
        self.assertEqual(
            summaries["instantml-spool-durable"]["overhead_vs_noop"]["tree_cpu_us_per_log"],
            30,
        )

    def test_render_markdown_labels_modes(self):
        payload = {
            "generated_at": "2026-05-21T00:00:00Z",
            "git": {"branch": "bench", "commit": "abc"},
            "environment": {"python": "3.11", "platform": "darwin", "machine": "arm64"},
            "protocol": {
                "steps": 10,
                "metrics_per_log": 6,
                "samples": 1,
                "warmup_logs_per_worker": 0,
                "cases": ["noop", "instantml-spool-durable"],
            },
            "notes": ["example caveat"],
            "samples": [sample("noop", 10, 8), sample("instantml-spool-durable", 40, 20)],
        }
        payload["summaries"] = bench.summarize_results(payload)

        rendered = bench.render_markdown(payload)

        self.assertIn("SDK Logging Overhead Benchmark", rendered)
        self.assertIn("InstantML process-spool mode", rendered)
        self.assertIn("example caveat", rendered)


def sample(case, tree_cpu_us, wall_us):
    return {
        "case": case,
        "sample_index": 0,
        "status": "ok",
        "steps": 10,
        "hot_loop": {
            "tree_cpu_us_per_log": tree_cpu_us,
            "parent_cpu_us_per_log": tree_cpu_us,
            "wall_us_per_log": wall_us,
        },
        "finish": {"tree_cpu_s": 0.01},
        "drain": None,
        "disk": {"bytes": 0, "files": 0},
    }


if __name__ == "__main__":
    unittest.main()
