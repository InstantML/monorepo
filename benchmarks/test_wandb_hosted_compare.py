import unittest
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
import wandb_hosted_compare as bench


class WandbHostedCompareTests(unittest.TestCase):
    def test_source_run_matches_hosted_seed_shape(self):
        row = bench.source_run(197, ["hosted-scale-control", "hosted-scale-data"])
        self.assertEqual(row.source_project, "hosted-scale-data")
        self.assertEqual(row.source_status, "failed")
        self.assertEqual(row.name, "hosted-scale-data-run-000198")
        self.assertIn("seed-97", row.tags)

    def test_history_indices_dashboard(self):
        indices = bench.history_indices("dashboard", 1000, 10, 5, "seed-13")
        self.assertTrue(set(range(990, 1000)).issubset(indices))
        self.assertTrue({13, 113, 213, 313, 413}.issubset(indices))

    def test_summary_eval_return_uses_precomputed_max(self):
        base = bench.precompute_eval_return_max(20)
        metrics = bench.summary_metrics(997, 20, base)
        self.assertIn("eval/return_mean", metrics)
        self.assertEqual(metrics["eval/return_mean"], metrics["eval_return_mean"])
        self.assertGreater(metrics["eval/return_mean"], bench.metric_value("eval/return_mean", 997, 1))

    def test_summarize_timings_uses_nearest_rank(self):
        summary = bench.summarize_timings([10, 20, 30, 40, 50])
        self.assertEqual(summary["p50_ms"], 30)
        self.assertEqual(summary["p95_ms"], 50)

    def test_split_ranges_balances_workers(self):
        self.assertEqual(bench.split_ranges(0, 10, 3), [(0, 4), (4, 7), (7, 10)])


if __name__ == "__main__":
    unittest.main()
