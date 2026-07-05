#!/usr/bin/env python3
"""Benchmark InstantML async queue SQLite write/read costs."""

from __future__ import annotations

import argparse
import json
import math
import platform
import shutil
import statistics
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable


REPO_ROOT = Path(__file__).resolve().parents[1]
SDK_ROOT = REPO_ROOT / "packages" / "python-sdk"
DEFAULT_BATCH_SIZES = [1, 16, 64, 256]
RESULT_VERSION = 1


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def metric_payload(index: int, metrics_per_event: int) -> dict[str, Any]:
    metrics = {
        f"metric/{metric_index:02d}": round(math.sin(index / (metric_index + 3)) + metric_index, 8)
        for metric_index in range(metrics_per_event)
    }
    return {
        "metrics": metrics,
        "step": index,
        "timestamp": f"2026-05-27T00:00:{index % 60:02d}Z",
        "preview": False,
        "preview_completion": 0.0,
    }


def chunks(items: list[Any], size: int) -> Iterable[list[Any]]:
    if size <= 0:
        raise ValueError("batch size must be positive")
    for index in range(0, len(items), size):
        yield items[index : index + size]


def measure_phase(callback: Any, denominator: int) -> tuple[Any, dict[str, Any]]:
    wall_start = time.perf_counter()
    cpu_start = time.process_time()
    value = callback()
    wall_s = time.perf_counter() - wall_start
    cpu_s = time.process_time() - cpu_start
    count = max(1, denominator)
    return value, {
        "wall_s": round(wall_s, 9),
        "cpu_s": round(cpu_s, 9),
        "wall_us_per_event": round(wall_s * 1_000_000 / count, 3),
        "cpu_us_per_event": round(cpu_s * 1_000_000 / count, 3),
        "events_per_second_wall": round(count / wall_s, 1) if wall_s else 0.0,
    }


def tree_stats(root: Path) -> dict[str, int]:
    files = 0
    bytes_written = 0
    if not root.exists():
        return {"files": 0, "bytes": 0}
    for path in root.rglob("*"):
        if path.is_file():
            files += 1
            try:
                bytes_written += path.stat().st_size
            except OSError:
                pass
    return {"files": files, "bytes": bytes_written}


def run_sample(tmp_root: Path, sample_index: int, batch_size: int, events: int, metrics_per_event: int) -> dict[str, Any]:
    sys.path.insert(0, str(SDK_ROOT))
    import instantml.async_queue as async_queue
    from instantml.async_queue import AsyncQueueRepository, DeliveryResult, drain_queue_once

    sample_root = tmp_root / f"batch-{batch_size}" / f"sample-{sample_index:03d}"
    sample_root.mkdir(parents=True, exist_ok=True)
    repository = AsyncQueueRepository(sample_root / "queue.sqlite3")
    repository.init_db()

    def prepare_events() -> list[Any]:
        return [
            repository.prepare_event(
                "POST",
                "/runs/run-1/metrics",
                metric_payload(index, metrics_per_event),
                idempotency_key=f"event-{index}",
                created_at=1_775_000_000.0 + index / 1000,
            )
            for index in range(events)
        ]

    prepared, prepare_delta = measure_phase(prepare_events, events)

    def write_events() -> dict[str, int]:
        inserted = 0
        dropped = 0
        write_batches = 0
        for batch in chunks(prepared, batch_size):
            result = repository.enqueue_many_prepared(batch)
            inserted += result.inserted
            dropped += result.dropped
            write_batches += 1
        return {"inserted": inserted, "dropped": dropped, "write_batches": write_batches}

    write_result, write_delta = measure_phase(write_events, events)
    disk_after_write = tree_stats(sample_root)

    original_send_request = async_queue._send_request

    # Count HTTP requests, not just drain cycles. Batched delivery groups
    # consecutive same-run metric events into one /metrics/batch call, which
    # routes through _send_request, so invocations here equal real round trips.
    http_requests = 0

    def fake_send_request(**kwargs: Any) -> DeliveryResult:
        nonlocal http_requests
        http_requests += 1
        json.dumps(kwargs["body"], separators=(",", ":"), sort_keys=False)
        return DeliveryResult(ok=True, retryable=False)

    async_queue._send_request = fake_send_request
    try:
        def drain_events() -> dict[str, int]:
            drained = 0
            drain_batches = 0
            while True:
                processed = drain_queue_once(repository, base_url="http://example.test")
                if processed <= 0:
                    break
                drained += processed
                drain_batches += 1
            return {"drained": drained, "drain_batches": drain_batches}

        drain_result, drain_delta = measure_phase(drain_events, events)
    finally:
        async_queue._send_request = original_send_request
        repository.close()

    disk_after_drain = tree_stats(sample_root)
    return {
        "version": RESULT_VERSION,
        "sample_index": sample_index,
        "batch_size": batch_size,
        "events": events,
        "metrics_per_event": metrics_per_event,
        "prepare": prepare_delta,
        "write": write_delta,
        "drain": drain_delta,
        "inserted": write_result["inserted"],
        "dropped": write_result["dropped"],
        "drained": drain_result["drained"],
        "http_requests": http_requests,
        "events_per_http_request": round(drain_result["drained"] / http_requests, 3) if http_requests else 0.0,
        "write_batches": write_result["write_batches"],
        "drain_batches": drain_result["drain_batches"],
        "disk_after_write": disk_after_write,
        "disk_after_drain": disk_after_drain,
    }


def percentile(sorted_values: list[float], p: float) -> float:
    if not sorted_values:
        return 0.0
    index = min(len(sorted_values) - 1, math.ceil(len(sorted_values) * p) - 1)
    return sorted_values[index]


def summarize_values(values: list[float]) -> dict[str, float | int]:
    sorted_values = sorted(values)
    if not sorted_values:
        return {"samples": 0, "median": 0.0, "p95": 0.0, "p99": 0.0, "mean": 0.0, "min": 0.0, "max": 0.0}
    return {
        "samples": len(sorted_values),
        "median": round(statistics.median(sorted_values), 3),
        "p95": round(percentile(sorted_values, 0.95), 3),
        "p99": round(percentile(sorted_values, 0.99), 3),
        "mean": round(statistics.fmean(sorted_values), 3),
        "min": round(sorted_values[0], 3),
        "max": round(sorted_values[-1], 3),
    }


def summarize_results(samples: list[dict[str, Any]]) -> dict[str, Any]:
    grouped: dict[int, list[dict[str, Any]]] = {}
    for sample in samples:
        grouped.setdefault(int(sample["batch_size"]), []).append(sample)
    summaries: dict[str, Any] = {}
    for batch_size, rows in sorted(grouped.items()):
        summaries[str(batch_size)] = {
            "batch_size": batch_size,
            "samples": len(rows),
            "prepare_wall_us_per_event": summarize_values([float(row["prepare"]["wall_us_per_event"]) for row in rows]),
            "prepare_cpu_us_per_event": summarize_values([float(row["prepare"]["cpu_us_per_event"]) for row in rows]),
            "write_wall_us_per_event": summarize_values([float(row["write"]["wall_us_per_event"]) for row in rows]),
            "write_cpu_us_per_event": summarize_values([float(row["write"]["cpu_us_per_event"]) for row in rows]),
            "write_events_per_second": summarize_values([float(row["write"]["events_per_second_wall"]) for row in rows]),
            "drain_wall_us_per_event": summarize_values([float(row["drain"]["wall_us_per_event"]) for row in rows]),
            "drain_cpu_us_per_event": summarize_values([float(row["drain"]["cpu_us_per_event"]) for row in rows]),
            "drain_events_per_second": summarize_values([float(row["drain"]["events_per_second_wall"]) for row in rows]),
            "write_batches": summarize_values([float(row["write_batches"]) for row in rows]),
            "drain_batches": summarize_values([float(row["drain_batches"]) for row in rows]),
            "http_requests": summarize_values([float(row["http_requests"]) for row in rows]),
            "events_per_http_request": summarize_values([float(row["events_per_http_request"]) for row in rows]),
            "disk_bytes_after_write": summarize_values([float(row["disk_after_write"]["bytes"]) for row in rows]),
        }
    return summaries


def git_metadata() -> dict[str, str | None]:
    def git_output(args: list[str]) -> str | None:
        try:
            return subprocess.check_output(["git", *args], cwd=REPO_ROOT, text=True).strip()
        except (OSError, subprocess.CalledProcessError):
            return None

    return {
        "branch": git_output(["branch", "--show-current"]),
        "commit": git_output(["rev-parse", "HEAD"]),
        "working_tree_dirty": "true" if git_output(["status", "--short"]) else "false",
    }


def cpu_brand() -> str | None:
    if sys.platform == "darwin":
        try:
            return subprocess.check_output(["sysctl", "-n", "machdep.cpu.brand_string"], text=True).strip()
        except (OSError, subprocess.CalledProcessError):
            return None
    if Path("/proc/cpuinfo").exists():
        for line in Path("/proc/cpuinfo").read_text(errors="ignore").splitlines():
            if line.lower().startswith("model name"):
                return line.split(":", 1)[1].strip()
    return platform.processor() or None


def run_benchmark(args: argparse.Namespace) -> dict[str, Any]:
    batch_sizes = [int(value.strip()) for value in args.batch_sizes.split(",") if value.strip()]
    if not batch_sizes:
        raise SystemExit("at least one batch size is required")
    temp_manager = tempfile.TemporaryDirectory(prefix="instantml-async-queue-io-") if not args.keep_temp else None
    tmp_root = Path(args.tmp_root or (temp_manager.name if temp_manager else tempfile.mkdtemp(prefix="instantml-async-queue-io-"))).resolve()
    tmp_root.mkdir(parents=True, exist_ok=True)
    try:
        samples = []
        for sample_index in range(args.samples):
            for batch_size in batch_sizes:
                samples.append(run_sample(tmp_root, sample_index, batch_size, args.events, args.metrics_per_event))
        payload = {
            "version": RESULT_VERSION,
            "generated_at": now_iso(),
            "git": git_metadata(),
            "environment": {
                "python": platform.python_version(),
                "platform": platform.platform(),
                "machine": platform.machine(),
                "processor": platform.processor(),
                "cpu_brand": cpu_brand(),
            },
            "protocol": {
                "samples": args.samples,
                "events": args.events,
                "metrics_per_event": args.metrics_per_event,
                "batch_sizes": batch_sizes,
                "tmp_root_kept": bool(args.keep_temp),
                "command": [Path(sys.argv[0]).name, *sys.argv[1:]],
            },
            "notes": [
                "Write timing measures AsyncQueueRepository.enqueue_many_prepared() over pre-serialized PreparedQueuedEvent objects.",
                "Prepare timing separately measures JSON serialization, idempotency assignment, byte counting, and event object creation.",
                "Drain/read timing uses drain_queue_once() with a fake successful transport, so it includes SQLite claim reads, JSON decode, fake request serialization, mark_processed updates, and pruning, but no network.",
                "http_requests counts actual _send_request invocations. Batched delivery groups consecutive same-run metric events into one /metrics/batch request, so events_per_http_request shows the round-trip reduction versus one request per event.",
                "SQLite runs with the SDK queue defaults: WAL journal mode, synchronous=NORMAL, producer timeout, and the default 1 MiB uploader drain byte budget.",
            ],
            "samples_raw": samples,
        }
        payload["summaries"] = summarize_results(samples)
        if args.output_json:
            Path(args.output_json).parent.mkdir(parents=True, exist_ok=True)
            Path(args.output_json).write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        if args.output_markdown:
            Path(args.output_markdown).write_text(render_markdown(payload), encoding="utf-8")
        return payload
    finally:
        if temp_manager is not None:
            temp_manager.cleanup()
        elif not args.keep_temp and args.tmp_root:
            shutil.rmtree(tmp_root, ignore_errors=True)


def render_markdown(payload: dict[str, Any]) -> str:
    protocol = payload["protocol"]
    lines = [
        "# Async Queue SQLite I/O Benchmark",
        "",
        f"Date: {payload['generated_at']}",
        "",
        "## Context",
        "",
        f"- Branch: `{payload['git'].get('branch')}`",
        f"- Benchmark subject commit: `{payload['git'].get('commit')}`",
        f"- Working tree dirty at run time: `{payload['git'].get('working_tree_dirty')}`",
        f"- Python: `{payload['environment'].get('python')}`",
        f"- Platform: `{payload['environment'].get('platform')}`",
        f"- CPU: `{payload['environment'].get('cpu_brand') or payload['environment'].get('processor')}`",
        f"- Events per sample: `{protocol['events']}`",
        f"- Metrics per event: `{protocol['metrics_per_event']}`",
        f"- Samples per batch size: `{protocol['samples']}`",
        f"- Batch sizes: `{', '.join(str(size) for size in protocol['batch_sizes'])}`",
        "",
        "## Caveats",
        "",
    ]
    lines.extend(f"- {note}" for note in payload["notes"])
    lines.extend([
        "",
        "## Summary",
        "",
        "| Batch size | Samples | Prepare wall us/event | Write wall us/event | p95 write us/event | Write events/sec | Drain/read wall us/event | p95 drain/read us/event | Drain/read events/sec | Median write batches | Median drain batches | Median HTTP requests | Median events/HTTP request | Disk bytes after write |",
        "| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ])
    for batch_size in protocol["batch_sizes"]:
        summary = payload["summaries"].get(str(batch_size))
        if not summary:
            continue
        lines.append(
            "| "
            + " | ".join([
                str(batch_size),
                str(summary["samples"]),
                f"{summary['prepare_wall_us_per_event']['median']:.3f}",
                f"{summary['write_wall_us_per_event']['median']:.3f}",
                f"{summary['write_wall_us_per_event']['p95']:.3f}",
                f"{summary['write_events_per_second']['median']:.0f}",
                f"{summary['drain_wall_us_per_event']['median']:.3f}",
                f"{summary['drain_wall_us_per_event']['p95']:.3f}",
                f"{summary['drain_events_per_second']['median']:.0f}",
                f"{summary['write_batches']['median']:.0f}",
                f"{summary['drain_batches']['median']:.0f}",
                f"{summary['http_requests']['median']:.0f}",
                f"{summary['events_per_http_request']['median']:.1f}",
                f"{summary['disk_bytes_after_write']['median']:.0f}",
            ])
            + " |"
        )
    return "\n".join(lines) + "\n"


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Benchmark InstantML async queue local SQLite I/O.")
    subparsers = parser.add_subparsers(dest="command", required=True)
    run_parser = subparsers.add_parser("run", help="run the benchmark matrix")
    run_parser.add_argument("--events", type=int, default=10_000)
    run_parser.add_argument("--metrics-per-event", type=int, default=6)
    run_parser.add_argument("--samples", type=int, default=5)
    run_parser.add_argument("--batch-sizes", default=",".join(str(size) for size in DEFAULT_BATCH_SIZES))
    run_parser.add_argument("--tmp-root", default=None)
    run_parser.add_argument("--keep-temp", action="store_true")
    run_parser.add_argument("--output-json", default=None)
    run_parser.add_argument("--output-markdown", default=None)
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if args.command == "run":
        payload = run_benchmark(args)
        if not args.output_json and not args.output_markdown:
            print(json.dumps(payload, indent=2, sort_keys=True))
        return 0
    parser.error(f"unknown command: {args.command}")
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
