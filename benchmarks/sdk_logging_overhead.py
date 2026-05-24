#!/usr/bin/env python3
"""Benchmark foreground SDK logging overhead.

This benchmark measures CPU and wall-time overhead around scalar metric logging.
It intentionally stays separate from the hosted W&B read/query benchmark because
those results answer a different question.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import platform
import random
import resource
import shutil
import statistics
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[1]
SDK_ROOT = REPO_ROOT / "packages" / "python-sdk"
DEFAULT_CASES = [
    "noop",
    "instantml-sync-null",
    "instantml-sync-live-null",
    "instantml-log-null",
    "instantml-spool-durable",
    "wandb-offline",
]
BASE_METRIC_KEYS = [
    "eval/return_mean",
    "eval/success_rate",
    "train/loss",
    "train/reward_mean",
    "system/cpu_percent",
    "system/gpu_util",
]
CASE_DESCRIPTIONS = {
    "noop": "Synthetic metric computation with no SDK logging.",
    "instantml-sync-null": "InstantML internal Run.log_metrics microbenchmark through a fake local transport that serializes bodies and does no network I/O.",
    "instantml-sync-live-null": "InstantML internal Run.log_metrics microbenchmark with the online heartbeat thread enabled through the same fake local transport.",
    "instantml-log-null": "InstantML internal ergonomic Run.log microbenchmark through the same fake local transport, including scalar classification.",
    "instantml-spool-durable": "InstantML process-spool mode writing one durable local event file per log call.",
    "wandb-offline": "W&B offline mode with quiet/no-git/no-code/no-console settings.",
}
RESULT_VERSION = 1


@dataclass(frozen=True)
class WorkerConfig:
    case: str
    sample_index: int
    steps: int
    metrics_per_log: int
    warmup_logs: int
    heartbeat_interval: float
    tmp_root: Path


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def metric_keys(count: int) -> list[str]:
    if count <= 0:
        raise ValueError("metrics_per_log must be positive")
    keys = list(BASE_METRIC_KEYS[:count])
    while len(keys) < count:
        keys.append(f"custom/metric_{len(keys) + 1:02d}")
    return keys


def metric_payload(step: int, count: int) -> dict[str, float]:
    payload: dict[str, float] = {}
    for index, key in enumerate(metric_keys(count)):
        payload[key] = round(
            math.sin((step + 1) / (index + 3)) * 10.0
            + math.log1p(step + index + 1)
            + index,
            8,
        )
    return payload


def consume_payload(payload: dict[str, float]) -> float:
    return sum(payload.values())


def configure_wandb_env(root: Path) -> None:
    os.environ["WANDB_SILENT"] = "true"
    os.environ["WANDB_QUIET"] = "true"
    os.environ["WANDB_CONSOLE"] = "off"
    os.environ["WANDB_DISABLE_GIT"] = "true"
    os.environ["WANDB_DISABLE_CODE"] = "true"
    os.environ["WANDB_ERROR_REPORTING"] = "false"
    os.environ["WANDB_MODE"] = "offline"
    os.environ["WANDB_DIR"] = str(root / "wandb")


def _psutil_module() -> Any | None:
    try:
        import psutil  # type: ignore
    except ModuleNotFoundError:
        return None
    return psutil


def process_snapshot() -> dict[str, Any]:
    psutil = _psutil_module()
    self_usage = resource.getrusage(resource.RUSAGE_SELF)
    child_usage = resource.getrusage(resource.RUSAGE_CHILDREN)
    live_child_cpu = 0.0
    rss_bytes = 0
    live_children = 0
    if psutil is not None:
        process = psutil.Process()
        try:
            rss_bytes += process.memory_info().rss
        except psutil.Error:
            pass
        for child in process.children(recursive=True):
            try:
                times = child.cpu_times()
                live_child_cpu += float(times.user + times.system)
                rss_bytes += child.memory_info().rss
                live_children += 1
            except psutil.Error:
                continue
    waited_child_cpu = float(child_usage.ru_utime + child_usage.ru_stime)
    parent_cpu = time.process_time()
    return {
        "wall_s": time.perf_counter(),
        "parent_cpu_s": parent_cpu,
        "waited_child_cpu_s": waited_child_cpu,
        "live_child_cpu_s": live_child_cpu,
        "tree_cpu_s": parent_cpu + waited_child_cpu + live_child_cpu,
        "rss_snapshot_bytes": rss_bytes,
        "voluntary_context_switches": int(self_usage.ru_nvcsw + child_usage.ru_nvcsw),
        "involuntary_context_switches": int(self_usage.ru_nivcsw + child_usage.ru_nivcsw),
        "live_children": live_children,
        "psutil_available": psutil is not None,
    }


def snapshot_delta(start: dict[str, Any], end: dict[str, Any]) -> dict[str, Any]:
    keys = [
        "wall_s",
        "parent_cpu_s",
        "waited_child_cpu_s",
        "live_child_cpu_s",
        "tree_cpu_s",
        "voluntary_context_switches",
        "involuntary_context_switches",
    ]
    delta = {}
    for key in keys:
        value = float(end[key]) - float(start[key])
        if key != "wall_s" and value < 0:
            value = 0.0
        delta[key] = round(value, 9)
    delta["rss_snapshot_bytes"] = max(int(start.get("rss_snapshot_bytes", 0)), int(end.get("rss_snapshot_bytes", 0)))
    delta["live_children_end"] = int(end.get("live_children", 0))
    return delta


def measure_phase(callback: Any) -> tuple[Any, dict[str, Any]]:
    start = process_snapshot()
    value = callback()
    end = process_snapshot()
    return value, snapshot_delta(start, end)


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


class FakeClient:
    def __init__(self) -> None:
        self.requests = 0
        self.serialized_bytes = 0

    def _request(
        self,
        method: str,
        path: str,
        body: dict[str, Any],
        idempotency_key: str | None = None,
    ) -> dict[str, Any]:
        del method, idempotency_key
        self.requests += 1
        self.serialized_bytes += len(json.dumps(body, separators=(",", ":"), sort_keys=False))
        if path.endswith("/artifacts/upload") or path.endswith("/artifacts"):
            return {"artifact": {"id": "fake-artifact"}}
        if path == "/runs":
            return {"run": {"id": "bench-run"}}
        return {"ok": True}


def setup_instantml_run(config: WorkerConfig) -> tuple[Any, FakeClient]:
    sys.path.insert(0, str(SDK_ROOT))
    from instantml.client import Run

    client = FakeClient()
    upload_mode = "spool" if config.case == "instantml-spool-durable" else "sync"
    run = Run(
        client=client,
        run_id=f"bench-{config.case}-{config.sample_index}",
        buffer_size=0,
        upload_mode=upload_mode,
        spool_dir=str(config.tmp_root / "spool"),
    )
    if config.case == "instantml-sync-live-null":
        run._start_heartbeat(interval=config.heartbeat_interval)
    return run, client


def setup_wandb_run(config: WorkerConfig) -> Any:
    configure_wandb_env(config.tmp_root)
    try:
        import wandb  # type: ignore
    except ModuleNotFoundError as exc:
        raise RuntimeError("wandb is not installed; install benchmarks/requirements-wandb.txt") from exc
    return wandb.init(
        project="instantml-sdk-overhead",
        name=f"bench-{config.sample_index}",
        mode="offline",
        dir=str(config.tmp_root / "wandb"),
        config={"steps": config.steps, "metrics_per_log": config.metrics_per_log},
        reinit=True,
    )


def log_once(case: str, target: Any, step: int, metrics_per_log: int) -> float:
    payload = metric_payload(step, metrics_per_log)
    checksum = consume_payload(payload)
    if case == "noop":
        return checksum
    if case == "instantml-log-null":
        target.log(payload, step=step)
        return checksum
    if case.startswith("instantml-"):
        target.log_metrics(payload, step=step)
        return checksum
    if case == "wandb-offline":
        target.log(payload, step=step)
        return checksum
    raise ValueError(f"unknown benchmark case: {case}")


def run_worker(config: WorkerConfig) -> dict[str, Any]:
    case_root = config.tmp_root / config.case / f"sample-{config.sample_index:03d}"
    case_root.mkdir(parents=True, exist_ok=True)
    active_config = WorkerConfig(
        case=config.case,
        sample_index=config.sample_index,
        steps=config.steps,
        metrics_per_log=config.metrics_per_log,
        warmup_logs=config.warmup_logs,
        heartbeat_interval=config.heartbeat_interval,
        tmp_root=case_root,
    )
    target: Any = None
    fake_client: FakeClient | None = None
    checksum = 0.0

    def setup() -> None:
        nonlocal target, fake_client
        if active_config.case == "noop":
            target = None
        elif active_config.case.startswith("instantml-"):
            target, fake_client = setup_instantml_run(active_config)
        elif active_config.case == "wandb-offline":
            target = setup_wandb_run(active_config)
        else:
            raise ValueError(f"unknown benchmark case: {active_config.case}")

    _, setup_delta = measure_phase(setup)

    for step in range(1, active_config.warmup_logs + 1):
        checksum += log_once(active_config.case, target, step, active_config.metrics_per_log)

    def hot_loop() -> None:
        nonlocal checksum
        for step in range(active_config.warmup_logs + 1, active_config.warmup_logs + active_config.steps + 1):
            checksum += log_once(active_config.case, target, step, active_config.metrics_per_log)

    _, hot_delta = measure_phase(hot_loop)

    def finish() -> None:
        if active_config.case.startswith("instantml-"):
            target.finish("finished")
        elif active_config.case == "wandb-offline":
            target.finish()

    _, finish_delta = measure_phase(finish)
    disk_after_finish = tree_stats(case_root)
    drain_delta: dict[str, Any] | None = None
    drain_count = 0
    if active_config.case == "instantml-spool-durable":
        sys.path.insert(0, str(SDK_ROOT))
        from instantml.uploader import drain_spool

        drain_client = FakeClient()

        def drain() -> None:
            nonlocal drain_count, fake_client
            drain_count = drain_spool(str(active_config.tmp_root / "spool"), client=drain_client)
            fake_client = drain_client

        _, drain_delta = measure_phase(drain)

    disk = tree_stats(case_root)
    result = {
        "version": RESULT_VERSION,
        "case": active_config.case,
        "sample_index": active_config.sample_index,
        "status": "ok",
        "steps": active_config.steps,
        "metrics_per_log": active_config.metrics_per_log,
        "scalar_values": active_config.steps * active_config.metrics_per_log,
        "warmup_logs": active_config.warmup_logs,
        "heartbeat_interval": active_config.heartbeat_interval if active_config.case == "instantml-sync-live-null" else None,
        "setup": setup_delta,
        "hot_loop": with_per_log(hot_delta, active_config.steps),
        "finish": finish_delta,
        "drain": with_per_log(drain_delta, drain_count) if drain_delta else None,
        "drained_events": drain_count,
        "disk_after_finish": disk_after_finish,
        "disk": disk,
        "fake_transport": {
            "requests": fake_client.requests if fake_client else 0,
            "serialized_bytes": fake_client.serialized_bytes if fake_client else 0,
        },
        "checksum": round(checksum, 6),
        "environment": worker_environment(),
    }
    return result


def with_per_log(delta: dict[str, Any] | None, count: int) -> dict[str, Any] | None:
    if delta is None:
        return None
    enriched = dict(delta)
    denominator = max(1, count)
    enriched["wall_us_per_log"] = round(float(delta["wall_s"]) * 1_000_000 / denominator, 3)
    enriched["parent_cpu_us_per_log"] = round(float(delta["parent_cpu_s"]) * 1_000_000 / denominator, 3)
    enriched["tree_cpu_us_per_log"] = round(float(delta["tree_cpu_s"]) * 1_000_000 / denominator, 3)
    return enriched


def worker_environment() -> dict[str, Any]:
    versions: dict[str, Any] = {
        "python": platform.python_version(),
        "platform": platform.platform(),
        "machine": platform.machine(),
    }
    try:
        import instantml  # type: ignore

        module_path = Path(instantml.__file__).resolve()
        try:
            versions["instantml_module"] = str(module_path.relative_to(REPO_ROOT))
        except ValueError:
            versions["instantml_module"] = str(module_path)
    except Exception:
        versions["instantml_module"] = None
    try:
        import wandb  # type: ignore

        versions["wandb_version"] = getattr(wandb, "__version__", None)
    except Exception:
        versions["wandb_version"] = None
    psutil = _psutil_module()
    versions["psutil_version"] = getattr(psutil, "__version__", None) if psutil else None
    return versions


def percentile(sorted_values: list[float], p: float) -> float:
    if not sorted_values:
        return 0.0
    index = min(len(sorted_values) - 1, math.ceil(len(sorted_values) * p) - 1)
    return sorted_values[index]


def summarize_values(values: list[float]) -> dict[str, float | int]:
    sorted_values = sorted(values)
    if not sorted_values:
        return {"samples": 0, "median": 0.0, "p95": 0.0, "mean": 0.0, "min": 0.0, "max": 0.0}
    return {
        "samples": len(sorted_values),
        "median": round(statistics.median(sorted_values), 3),
        "p95": round(percentile(sorted_values, 0.95), 3),
        "mean": round(statistics.fmean(sorted_values), 3),
        "min": round(sorted_values[0], 3),
        "max": round(sorted_values[-1], 3),
    }


def summarize_case(case: str, results: list[dict[str, Any]], noop: dict[str, Any] | None) -> dict[str, Any]:
    hot = [result["hot_loop"] for result in results if result.get("status") == "ok"]
    summary = {
        "case": case,
        "description": CASE_DESCRIPTIONS.get(case, ""),
        "samples": len(hot),
        "wall_us_per_log": summarize_values([float(item["wall_us_per_log"]) for item in hot]),
        "parent_cpu_us_per_log": summarize_values([float(item["parent_cpu_us_per_log"]) for item in hot]),
        "tree_cpu_us_per_log": summarize_values([float(item["tree_cpu_us_per_log"]) for item in hot]),
        "finish_tree_cpu_s": summarize_values([float(result["finish"]["tree_cpu_s"]) for result in results]),
        "drain_tree_cpu_s": summarize_values([
            float(result["drain"]["tree_cpu_s"])
            for result in results
            if isinstance(result.get("drain"), dict)
        ]),
        "disk_bytes": summarize_values([float(result.get("disk_after_finish", result["disk"])["bytes"]) for result in results]),
        "disk_files": summarize_values([float(result.get("disk_after_finish", result["disk"])["files"]) for result in results]),
        "disk_bytes_per_measured_log": summarize_values([float(result.get("disk_after_finish", result["disk"])["bytes"]) / max(1, int(result["steps"])) for result in results]),
        "worker_tree_cpu_s": summarize_values([
            float(result.get("worker_process", {}).get("tree_cpu_s", 0.0))
            for result in results
            if isinstance(result.get("worker_process"), dict)
        ]),
    }
    if noop is not None and case != "noop":
        noop_cpu = float(noop["tree_cpu_us_per_log"]["median"])
        case_cpu = float(summary["tree_cpu_us_per_log"]["median"])
        noop_wall = float(noop["wall_us_per_log"]["median"])
        case_wall = float(summary["wall_us_per_log"]["median"])
        summary["overhead_vs_noop"] = {
            "tree_cpu_us_per_log": round(case_cpu - noop_cpu, 3),
            "wall_us_per_log": round(case_wall - noop_wall, 3),
            "tree_cpu_ratio": round(case_cpu / noop_cpu, 3) if noop_cpu else None,
            "wall_ratio": round(case_wall / noop_wall, 3) if noop_wall else None,
        }
    return summary


def summarize_results(payload: dict[str, Any]) -> dict[str, Any]:
    grouped: dict[str, list[dict[str, Any]]] = {}
    for result in payload["samples"]:
        if result.get("status") == "ok":
            grouped.setdefault(result["case"], []).append(result)
    prelim = {case: summarize_case(case, rows, None) for case, rows in grouped.items()}
    noop = prelim.get("noop")
    return {case: summarize_case(case, rows, noop) for case, rows in grouped.items()}


def sample_plan(cases: list[str], samples: int, seed: int) -> list[tuple[int, str]]:
    plan: list[tuple[int, str]] = []
    for sample_index in range(samples):
        order = list(cases)
        random.Random(seed + sample_index).shuffle(order)
        plan.extend((sample_index, case) for case in order)
    return plan


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


def run_worker_subprocess(
    config: WorkerConfig,
    python: str,
) -> dict[str, Any]:
    env = os.environ.copy()
    pythonpath = str(SDK_ROOT)
    if env.get("PYTHONPATH"):
        pythonpath = f"{pythonpath}{os.pathsep}{env['PYTHONPATH']}"
    env["PYTHONPATH"] = pythonpath
    command = [
        python,
        str(Path(__file__).resolve()),
        "worker",
        "--case",
        config.case,
        "--sample-index",
        str(config.sample_index),
        "--steps",
        str(config.steps),
        "--metrics-per-log",
        str(config.metrics_per_log),
        "--warmup-logs",
        str(config.warmup_logs),
        "--heartbeat-interval",
        str(config.heartbeat_interval),
        "--tmp-root",
        str(config.tmp_root),
    ]
    completed, worker_process = run_monitored(command, cwd=REPO_ROOT, env=env)
    if completed.returncode != 0:
        return {
            "case": config.case,
            "sample_index": config.sample_index,
            "status": "failed",
            "returncode": completed.returncode,
            "stdout": completed.stdout[-4000:],
            "stderr": completed.stderr[-4000:],
        }
    try:
        result = json.loads(completed.stdout)
        if isinstance(result, dict):
            result["worker_process"] = worker_process
        return result
    except json.JSONDecodeError:
        return {
            "case": config.case,
            "sample_index": config.sample_index,
            "status": "failed",
            "returncode": completed.returncode,
            "stdout": completed.stdout[-4000:],
            "stderr": completed.stderr[-4000:],
        }


def run_monitored(command: list[str], cwd: Path, env: dict[str, str]) -> tuple[subprocess.CompletedProcess[str], dict[str, Any]]:
    psutil = _psutil_module()
    start = time.perf_counter()
    with tempfile.TemporaryFile("w+t", encoding="utf-8") as stdout_file, tempfile.TemporaryFile("w+t", encoding="utf-8") as stderr_file:
        process = subprocess.Popen(command, cwd=cwd, env=env, text=True, stdout=stdout_file, stderr=stderr_file)
        cpu_by_pid: dict[int, float] = {}
        max_rss = 0
        if psutil is not None:
            try:
                root = psutil.Process(process.pid)
                while True:
                    collect_process_tree_snapshot(root, cpu_by_pid)
                    max_rss = max(max_rss, process_tree_rss(root))
                    if process.poll() is not None:
                        collect_process_tree_snapshot(root, cpu_by_pid)
                        max_rss = max(max_rss, process_tree_rss(root))
                        break
                    time.sleep(0.005)
            except psutil.Error:
                process.wait()
        else:
            process.wait()
        process.wait()
        stdout_file.seek(0)
        stderr_file.seek(0)
        stdout = stdout_file.read()
        stderr = stderr_file.read()
    worker_process = {
        "wall_s": round(time.perf_counter() - start, 9),
        "tree_cpu_s": round(sum(cpu_by_pid.values()), 9),
        "rss_snapshot_bytes": max_rss,
        "psutil_available": psutil is not None,
    }
    return subprocess.CompletedProcess(command, process.returncode, stdout, stderr), worker_process


def collect_process_tree_snapshot(root: Any, cpu_by_pid: dict[int, float]) -> None:
    processes = [root]
    try:
        processes.extend(root.children(recursive=True))
    except Exception:
        pass
    for process in processes:
        try:
            times = process.cpu_times()
            cpu_by_pid[process.pid] = max(cpu_by_pid.get(process.pid, 0.0), float(times.user + times.system))
        except Exception:
            continue


def process_tree_rss(root: Any) -> int:
    total = 0
    processes = [root]
    try:
        processes.extend(root.children(recursive=True))
    except Exception:
        pass
    for process in processes:
        try:
            total += int(process.memory_info().rss)
        except Exception:
            continue
    return total


def run_benchmark(args: argparse.Namespace) -> dict[str, Any]:
    cases = [case.strip() for case in args.cases.split(",") if case.strip()]
    unknown = set(cases) - set(DEFAULT_CASES)
    if unknown:
        raise SystemExit(f"unknown cases: {', '.join(sorted(unknown))}")
    temp_manager = tempfile.TemporaryDirectory(prefix="instantml-sdk-overhead-") if not args.keep_temp else None
    tmp_root = Path(args.tmp_root or (temp_manager.name if temp_manager else tempfile.mkdtemp(prefix="instantml-sdk-overhead-"))).resolve()
    tmp_root.mkdir(parents=True, exist_ok=True)
    try:
        samples: list[dict[str, Any]] = []
        for sample_index, case in sample_plan(cases, args.samples, args.seed):
            samples.append(run_worker_subprocess(
                WorkerConfig(
                    case=case,
                    sample_index=sample_index,
                    steps=args.steps,
                    metrics_per_log=args.metrics_per_log,
                    warmup_logs=args.warmup_logs,
                    heartbeat_interval=args.heartbeat_interval,
                    tmp_root=tmp_root,
                ),
                args.python,
            ))
        payload = {
            "version": RESULT_VERSION,
            "generated_at": now_iso(),
            "git": git_metadata(),
            "protocol": {
                "samples": args.samples,
                "steps": args.steps,
                "metrics_per_log": args.metrics_per_log,
                "warmup_logs_per_worker": args.warmup_logs,
                "heartbeat_interval": args.heartbeat_interval,
                "seed": args.seed,
                "cases": cases,
                "sample_order": sample_plan(cases, args.samples, args.seed),
                "python": args.python,
                "tmp_root_kept": bool(args.keep_temp),
                "command": [Path(sys.argv[0]).name, *sys.argv[1:]],
            },
            "environment": {
                "python": platform.python_version(),
                "platform": platform.platform(),
                "machine": platform.machine(),
                "processor": platform.processor(),
                "cpu_brand": cpu_brand(),
            },
            "notes": [
                "Hot-loop timings exclude setup/init and finish/drain phases; those phases are reported separately.",
                "InstantML sync-null/log-null are internal null-transport microbenchmarks and are not remote persistence benchmarks.",
                "InstantML sync-live-null uses the same null transport plus the SDK heartbeat thread. The heartbeat interval is configurable so runs can report default and stress settings explicitly.",
                "InstantML spool-durable writes one local durable event file per log call; uploader drain CPU is reported separately.",
                "W&B offline uses local/offline mode and may perform work in a service process; hot-loop tree CPU is phase-sampled, while total worker CPU is monitored from the parent process.",
                "Finish and drain columns are case-specific lifecycle costs, not identical provider phases.",
                "Disk bytes are measured after finish and include setup, warmup, and finish artifacts, not just measured hot-loop logs.",
            ],
            "samples": samples,
        }
        payload["summaries"] = summarize_results(payload)
        if args.output_json:
            write_json(Path(args.output_json), payload)
        if args.output_markdown:
            Path(args.output_markdown).write_text(render_markdown(payload), encoding="utf-8")
        return payload
    finally:
        if temp_manager is not None:
            temp_manager.cleanup()
        elif not args.keep_temp and args.tmp_root:
            shutil.rmtree(tmp_root, ignore_errors=True)


def write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def render_markdown(payload: dict[str, Any]) -> str:
    protocol = payload["protocol"]
    versions = sample_versions(payload)
    lines = [
        "# SDK Logging Overhead Benchmark",
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
        f"- W&B version: `{versions.get('wandb_version')}`",
        f"- psutil version: `{versions.get('psutil_version')}`",
        f"- InstantML module: `{versions.get('instantml_module')}`",
        f"- Steps per sample: `{protocol['steps']}`",
        f"- Metrics per log call: `{protocol['metrics_per_log']}`",
        f"- Samples per case: `{protocol['samples']}`",
        f"- Warmup logs per worker: `{protocol['warmup_logs_per_worker']}`",
        f"- Live heartbeat interval: `{protocol.get('heartbeat_interval')}` seconds",
        f"- Sample order seed: `{protocol.get('seed')}`",
        "",
        "## Caveats",
        "",
    ]
    lines.extend(f"- {note}" for note in payload["notes"])
    lines.extend([
        "",
        "## Hot Loop Summary",
        "",
        "| Case | Samples | Median wall us/log | Median tree CPU us/log | p95 tree CPU us/log | Tree CPU overhead vs noop | Median total worker CPU s | Median finish CPU s | Median drain CPU s | Median disk bytes after finish |",
        "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ])
    for case in protocol["cases"]:
        summary = payload["summaries"].get(case)
        if not summary:
            lines.append(f"| `{case}` | 0 | n/a | n/a | n/a | n/a | n/a | n/a | n/a |")
            continue
        overhead = summary.get("overhead_vs_noop", {})
        overhead_text = "baseline" if case == "noop" else f"{overhead.get('tree_cpu_us_per_log', 0):.3f} us/log"
        lines.append(
            "| "
            + " | ".join([
                f"`{case}`",
                str(summary["samples"]),
                f"{summary['wall_us_per_log']['median']:.3f}",
                f"{summary['tree_cpu_us_per_log']['median']:.3f}",
                f"{summary['tree_cpu_us_per_log']['p95']:.3f}",
                overhead_text,
                f"{summary['worker_tree_cpu_s']['median']:.6f}",
                f"{summary['finish_tree_cpu_s']['median']:.6f}",
                f"{summary['drain_tree_cpu_s']['median']:.6f}",
                f"{summary['disk_bytes']['median']:.0f}",
            ])
            + " |"
        )
    lines.extend([
        "",
        "## Case Notes",
        "",
    ])
    for case in protocol["cases"]:
        lines.append(f"- `{case}`: {CASE_DESCRIPTIONS.get(case, '')}")
    failed = [sample for sample in payload["samples"] if sample.get("status") != "ok"]
    if failed:
        lines.extend(["", "## Failed Samples", ""])
        for sample in failed:
            lines.append(f"- `{sample.get('case')}` sample `{sample.get('sample_index')}`: `{sample.get('status')}`")
    return "\n".join(lines) + "\n"


def sample_versions(payload: dict[str, Any]) -> dict[str, Any]:
    for sample in payload.get("samples", []):
        environment = sample.get("environment")
        if isinstance(environment, dict):
            return environment
    return {}


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Benchmark InstantML and W&B SDK logging overhead.")
    subparsers = parser.add_subparsers(dest="command", required=True)

    run_parser = subparsers.add_parser("run", help="run the benchmark matrix")
    run_parser.add_argument("--steps", type=int, default=2000)
    run_parser.add_argument("--metrics-per-log", type=int, default=6)
    run_parser.add_argument("--samples", type=int, default=5)
    run_parser.add_argument("--warmup-logs", type=int, default=100)
    run_parser.add_argument("--heartbeat-interval", type=float, default=15.0)
    run_parser.add_argument("--seed", type=int, default=20260521)
    run_parser.add_argument("--cases", default=",".join(DEFAULT_CASES))
    run_parser.add_argument("--python", default=sys.executable)
    run_parser.add_argument("--tmp-root", default=None)
    run_parser.add_argument("--keep-temp", action="store_true")
    run_parser.add_argument("--output-json", default=None)
    run_parser.add_argument("--output-markdown", default=None)

    worker_parser = subparsers.add_parser("worker", help=argparse.SUPPRESS)
    worker_parser.add_argument("--case", required=True)
    worker_parser.add_argument("--sample-index", type=int, required=True)
    worker_parser.add_argument("--steps", type=int, required=True)
    worker_parser.add_argument("--metrics-per-log", type=int, required=True)
    worker_parser.add_argument("--warmup-logs", type=int, required=True)
    worker_parser.add_argument("--heartbeat-interval", type=float, required=True)
    worker_parser.add_argument("--tmp-root", required=True)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.command == "worker":
        result = run_worker(
            WorkerConfig(
                case=args.case,
                sample_index=args.sample_index,
                steps=args.steps,
                metrics_per_log=args.metrics_per_log,
                warmup_logs=args.warmup_logs,
                heartbeat_interval=args.heartbeat_interval,
                tmp_root=Path(args.tmp_root),
            )
        )
        print(json.dumps(result, sort_keys=True))
        return 0
    payload = run_benchmark(args)
    failed = [sample for sample in payload["samples"] if sample.get("status") != "ok"]
    if failed:
        print(render_markdown(payload))
        return 1
    if not args.output_markdown:
        print(render_markdown(payload))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
