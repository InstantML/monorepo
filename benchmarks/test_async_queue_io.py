import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import async_queue_io as bench


class AsyncQueueIoBenchmarkTests(unittest.TestCase):
    def test_chunks_rejects_invalid_size(self):
        with self.assertRaises(ValueError):
            list(bench.chunks([1], 0))

    def test_chunks_preserves_order(self):
        self.assertEqual(list(bench.chunks([1, 2, 3, 4, 5], 2)), [[1, 2], [3, 4], [5]])

    def test_metric_payload_is_deterministic_and_sized(self):
        payload = bench.metric_payload(7, 4)

        self.assertEqual(payload, bench.metric_payload(7, 4))
        self.assertEqual(len(payload["metrics"]), 4)
        self.assertEqual(payload["step"], 7)

    def test_summarize_results_groups_batch_sizes(self):
        payload = {
            "samples": [
                sample(1, write_us=10, drain_us=20),
                sample(1, write_us=30, drain_us=40),
                sample(64, write_us=4, drain_us=22),
            ],
        }

        summaries = bench.summarize_results(payload["samples"])

        self.assertEqual(summaries["1"]["write_wall_us_per_event"]["median"], 20)
        self.assertEqual(summaries["64"]["drain_wall_us_per_event"]["median"], 22)

    def test_render_markdown_mentions_write_and_read(self):
        payload = {
            "generated_at": "2026-05-27T00:00:00Z",
            "git": {"branch": "bench", "commit": "abc", "working_tree_dirty": "true"},
            "environment": {"python": "3.11", "platform": "darwin", "machine": "arm64"},
            "protocol": {
                "events": 10,
                "metrics_per_event": 6,
                "samples": 1,
                "batch_sizes": [64],
            },
            "notes": ["example note"],
            "summaries": bench.summarize_results([sample(64, write_us=4, drain_us=22)]),
        }

        rendered = bench.render_markdown(payload)

        self.assertIn("Async Queue SQLite I/O Benchmark", rendered)
        self.assertIn("Drain/read wall us/event", rendered)
        self.assertIn("example note", rendered)


def sample(batch_size, write_us, drain_us):
    return {
        "batch_size": batch_size,
        "prepare": {"wall_us_per_event": 2, "cpu_us_per_event": 2},
        "write": {
            "wall_us_per_event": write_us,
            "cpu_us_per_event": write_us,
            "events_per_second_wall": 1_000_000 / write_us,
        },
        "drain": {
            "wall_us_per_event": drain_us,
            "cpu_us_per_event": drain_us,
            "events_per_second_wall": 1_000_000 / drain_us,
        },
        "write_batches": 10,
        "drain_batches": 2,
        "disk_after_write": {"bytes": 1024, "files": 3},
    }


if __name__ == "__main__":
    unittest.main()
