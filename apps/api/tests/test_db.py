import math

import pytest

from instantml_api import db


def test_project_creation_is_idempotent(tmp_path):
    db_path = tmp_path / "test.sqlite3"
    first = db.create_project(db_path, "cartpole", "demo")
    second = db.create_project(db_path, "cartpole", "ignored")

    assert first == second
    assert db.list_projects(db_path) == [first]
    assert db.default_db_path().name == "instantml.sqlite3"


def test_run_lifecycle_and_metric_queries_are_bounded(tmp_path):
    db_path = tmp_path / "test.sqlite3"
    run = db.create_run(
        db_path,
        project="cartpole",
        name="seed-1",
        config={"seed": 1},
        tags=["rl"],
        metadata={"host": "local"},
    )

    assert run["status"] == "running"
    assert run["project"] == "cartpole"
    assert db.list_runs(db_path, project="cartpole")[0]["id"] == run["id"]
    assert db.list_runs(db_path, project_id=run["project_id"])[0]["id"] == run["id"]
    assert (
        db.log_metrics(
            db_path,
            run["id"],
            {"reward": 1, "loss": 0.5},
            step=0.5,
            timestamp="2026-05-09T00:00:00Z",
        )
        == 2
    )
    assert db.log_metrics(db_path, run["id"], {"reward": 2}, step=1) == 1

    first = db.get_metrics(db_path, run["id"], key="reward", start_step=0.5, end_step=0.5, limit=1)
    assert first[0].created_at == "2026-05-09T00:00:00Z"
    metrics = db.get_metrics(db_path, run["id"], key="reward", start_step=1, end_step=1, limit=1)
    assert [(point.key, point.step, point.value) for point in metrics] == [("reward", 1, 2.0)]

    finished = db.update_run_status(db_path, run["id"], "finished")
    assert finished["status"] == "finished"
    assert finished["finished_at"].endswith("Z")


def test_performance_guardrail_bounded_metric_query(tmp_path):
    db_path = tmp_path / "test.sqlite3"
    for run_index in range(50):
        run = db.create_run(db_path, project="scale", name=f"run-{run_index}")
        for step in range(1000):
            db.log_metrics(db_path, run["id"], {"reward": step + run_index}, step=step)

    run = db.list_runs(db_path, project="scale", limit=1)[0]
    metrics = db.get_metrics(db_path, run["id"], key="reward", start_step=10, limit=5)

    assert len(metrics) == 5
    assert [point.step for point in metrics] == [10, 11, 12, 13, 14]


@pytest.mark.parametrize(
    ("call", "message"),
    [
        (lambda path: db.create_project(path, ""), "project name"),
        (lambda path: db.create_project(path, "x", description=123), "description"),
        (lambda path: db.create_run(path, "x", config=[]), "config"),
        (lambda path: db.create_run(path, "x", tags=[""]), "tags"),
        (lambda path: db.create_run(path, "x", metadata=[]), "metadata"),
        (lambda path: db.log_metrics(path, "missing", {"x": 1}, -1), "step"),
        (lambda path: db.log_metrics(path, "missing", {"x": 1}, True), "step"),
        (lambda path: db.log_metrics(path, "missing", {"x": 1}, "1"), "step"),
        (lambda path: db.log_metrics(path, "missing", {"x": 1}, ""), "step"),
        (lambda path: db.log_metrics(path, "missing", {"x": 1}, []), "step"),
        (lambda path: db.log_metrics(path, "missing", {"x": 1}, None), "step"),
        (lambda path: db.log_metrics(path, "missing", {"x": 1}, 0, timestamp=""), "timestamp"),
        (lambda path: db.log_metrics(path, "missing", {"x": 1}, 0, timestamp="never"), "timestamp"),
        (lambda path: db.log_metrics(path, "missing", {}, 0), "metrics"),
        (lambda path: db.log_metrics(path, "missing", {"x": math.inf}, 0), "finite"),
        (lambda path: db.log_metrics(path, "missing", {"x": True}, 0), "finite"),
        (lambda path: db.list_runs(path, limit=0), "limit"),
        (lambda path: db.list_runs(path, limit="many"), "limit"),
        (lambda path: db.list_runs(path, offset=-1), "offset"),
        (lambda path: db.list_runs(path, offset="start"), "offset"),
        (lambda path: db.get_metrics(path, "missing", start_step="nope"), "start_step"),
        (lambda path: db.get_metrics(path, "missing", start_step=True), "start_step"),
        (lambda path: db.get_metrics(path, "missing", start_step=-1), "start_step"),
        (lambda path: db.get_metrics(path, "missing", start_step=2, end_step=1), "start_step"),
        (lambda path: db.update_run_status(path, "missing", "paused"), "status"),
    ],
)
def test_validation_errors(tmp_path, call, message):
    with pytest.raises(db.ValidationError, match=message):
        call(tmp_path / "test.sqlite3")


def test_not_found_errors(tmp_path):
    db_path = tmp_path / "test.sqlite3"

    with pytest.raises(db.NotFoundError):
        db.get_run(db_path, "missing")
    with pytest.raises(db.NotFoundError):
        db.update_run_status(db_path, "missing", "finished")
    with pytest.raises(db.NotFoundError):
        db.log_metrics(db_path, "missing", {"reward": 1}, 0)
    with pytest.raises(db.NotFoundError):
        db.get_metrics(db_path, "missing")


def test_json_serialization_validation(tmp_path):
    db_path = tmp_path / "test.sqlite3"
    with pytest.raises(db.ValidationError, match="JSON serializable"):
        db.create_run(db_path, "cartpole", config={"bad": object()})


def test_default_metric_limit_and_running_status_reset(tmp_path):
    db_path = tmp_path / "test.sqlite3"
    run = db.create_run(db_path, "cartpole")
    db.log_metrics(db_path, run["id"], {"reward": 1}, 0)

    assert len(db.get_metrics(db_path, run["id"], limit=None)) == 1
    failed = db.update_run_status(db_path, run["id"], "failed")
    assert failed["finished_at"] is not None
    running = db.update_run_status(db_path, run["id"], "running")
    assert running["finished_at"] is None
