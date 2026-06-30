import urllib.parse

import pytest

import instantml as im
import instantml.client as client_module
from instantml.client import Client, InstantMLError


def _parsed(path):
    parsed = urllib.parse.urlsplit(path)
    return parsed.path, urllib.parse.parse_qs(parsed.query)


def test_query_runs_autopaginates_and_returns_page(monkeypatch):
    calls = []
    responses = [
        {"runs": [{"id": "run-1"}], "next_cursor": "cursor-2"},
        {"runs": [{"id": "run-2"}], "next_cursor": None},
    ]

    def fake_request(self, method, path, body=None, idempotency_key=None, retry_rate_limits=True):
        calls.append((self, method, path, body))
        return responses.pop(0)

    monkeypatch.setattr(Client, "_request", fake_request)

    page = im.Api(base_url="http://example.test", timeout=3, api_key="secret").query_runs(
        project="cartpole",
        q="tag:baseline",
        status="finished",
        sort_by="metric-best",
        metric_key="eval/return_mean",
        limit=2,
        max_pages=2,
    )

    assert isinstance(page, im.Page)
    assert list(page) == [{"id": "run-1"}, {"id": "run-2"}]
    assert page[1]["id"] == "run-2"
    assert len(page) == 2
    assert page.next_cursor is None
    assert page.raw == {
        "pages": [
            {"runs": [{"id": "run-1"}], "next_cursor": "cursor-2"},
            {"runs": [{"id": "run-2"}], "next_cursor": None},
        ]
    }
    assert calls[0][0].base_url == "http://example.test"
    assert calls[0][0].timeout == 3
    assert calls[0][0].api_key == "secret"
    assert calls[0][1] == "GET"
    first_path, first_params = _parsed(calls[0][2])
    second_path, second_params = _parsed(calls[1][2])
    assert first_path == "/api/runs/summary"
    assert second_path == "/api/runs/summary"
    assert first_params == {
        "limit": ["2"],
        "project": ["cartpole"],
        "q": ["tag:baseline"],
        "status": ["finished"],
        "sort_by": ["metric-best"],
        "metric_key": ["eval/return_mean"],
    }
    assert second_params["cursor"] == ["cursor-2"]


def test_iter_runs_yields_lazily_in_server_order(monkeypatch):
    responses = [
        {"runs": [{"id": "run-1"}], "next_cursor": "cursor-2"},
        {"runs": [{"id": "run-2"}], "next_cursor": "cursor-3"},
        {"runs": [{"id": "run-3"}], "next_cursor": None},
    ]
    calls = []

    def fake_request(self, method, path, body=None, idempotency_key=None, retry_rate_limits=True):
        calls.append(path)
        return responses.pop(0)

    monkeypatch.setattr(Client, "_request", fake_request)

    runs = list(im.Api(base_url="http://example.test").iter_runs(page_size=1, max_pages=2))

    assert runs == [{"id": "run-1"}, {"id": "run-2"}]
    assert len(calls) == 2
    assert urllib.parse.parse_qs(urllib.parse.urlsplit(calls[1]).query)["cursor"] == ["cursor-2"]


def test_iter_runs_stops_when_server_returns_no_cursor(monkeypatch):
    calls = []

    def fake_request(self, method, path, body=None, idempotency_key=None, retry_rate_limits=True):
        calls.append(path)
        return {"runs": [{"id": "run-1"}], "next_cursor": None}

    monkeypatch.setattr(Client, "_request", fake_request)

    runs = list(im.Api(base_url="http://example.test").iter_runs(page_size=1))

    assert runs == [{"id": "run-1"}]
    assert len(calls) == 1


def test_query_metrics_orders_by_caller_run_then_key_and_omits_empty(monkeypatch):
    calls = []

    def fake_request(self, method, path, body=None, idempotency_key=None, retry_rate_limits=True):
        calls.append((method, path, body))
        if body["key"] == "loss":
            return {
                "series": [
                    {"run_id": "run-2", "metrics": [{"step": 1, "value": 0.4}]},
                    {"run_id": "run-1", "metrics": [{"step": 1, "value": 0.5}]},
                ],
                "effective_limit": 25,
            }
        return {
            "series": [
                {"run_id": "run-2", "metrics": []},
                {"run_id": "run-1", "metrics": [{"step": 1, "value": 0.9}]},
            ],
            "effective_limit": 25,
        }

    monkeypatch.setattr(Client, "_request", fake_request)

    page = im.Api(base_url="http://example.test").query_metrics(
        ["run-1", "run-2"],
        ["loss", "acc"],
        step_min=0,
        step_max=10,
        point_limit=25,
        buckets=10,
    )

    assert isinstance(page, im.MetricSeriesPage)
    assert page.point_limit == 25
    assert len(page) == 3
    assert page[0]["run_id"] == "run-1"
    assert [entry["key"] for entry in page] == ["loss", "acc", "loss"]
    assert [(entry["run_id"], entry["key"]) for entry in page.series] == [
        ("run-1", "loss"),
        ("run-1", "acc"),
        ("run-2", "loss"),
    ]
    assert calls == [
        (
            "POST",
            "/api/metrics/series",
            {
                "key": "loss",
                "run_ids": ["run-1", "run-2"],
                "limit": 25,
                "start_step": 0,
                "end_step": 10,
                "buckets": 10,
            },
        ),
        (
            "POST",
            "/api/metrics/series",
            {
                "key": "acc",
                "run_ids": ["run-1", "run-2"],
                "limit": 25,
                "start_step": 0,
                "end_step": 10,
                "buckets": 10,
            },
        ),
    ]
    assert "pages" in page.raw


def test_query_metrics_validates_bounds_before_request(monkeypatch):
    def fake_request(*args, **kwargs):
        raise AssertionError("network should not be used")

    monkeypatch.setattr(Client, "_request", fake_request)
    api = im.Api(base_url="http://example.test")

    with pytest.raises(ValueError, match="time_min"):
        api.query_metrics(["run-1"], ["loss"], time_min="2026-01-01T00:00:00Z")
    with pytest.raises(ValueError, match="x_axis"):
        api.query_metrics(["run-1"], ["loss"], x_axis="time")
    with pytest.raises(ValueError, match="run_ids"):
        api.query_metrics([], ["loss"])
    with pytest.raises(ValueError, match="duplicates"):
        api.query_metrics(["run-1", "run-1"], ["loss"])
    with pytest.raises(ValueError, match="point_limit"):
        api.query_metrics(["run-1"], ["loss"], point_limit=10_001)


def test_query_validation_rejects_bad_inputs_before_request(monkeypatch):
    def fake_request(*args, **kwargs):
        raise AssertionError("network should not be used")

    monkeypatch.setattr(Client, "_request", fake_request)
    api = im.Api(base_url="http://example.test")

    with pytest.raises(TypeError, match="limit"):
        api.query_runs(limit=True)
    with pytest.raises(ValueError, match="limit"):
        api.query_runs(limit=0)
    with pytest.raises(ValueError, match="max_pages"):
        api.query_runs(max_pages=0)
    with pytest.raises(TypeError, match="project"):
        api.query_runs(project=123)
    with pytest.raises(ValueError, match="q"):
        api.query_runs(q="x" * 513)
    with pytest.raises(TypeError, match="run_ids"):
        api.query_metrics("run-1", ["loss"])
    with pytest.raises(ValueError, match="run_id"):
        api.query_metrics([" "], ["loss"])
    with pytest.raises(ValueError, match="keys"):
        api.query_metrics(["run-1"], [f"k-{idx}" for idx in range(26)])
    with pytest.raises(ValueError, match="key"):
        api.query_metrics(["run-1"], [" "])
    with pytest.raises(TypeError, match="step_min"):
        api.query_metrics(["run-1"], ["loss"], step_min=True)
    with pytest.raises(ValueError, match="step_min"):
        api.query_metrics(["run-1"], ["loss"], step_min=float("nan"))
    with pytest.raises(ValueError, match="step_min"):
        api.query_metrics(["run-1"], ["loss"], step_min=-1)
    with pytest.raises(ValueError, match="step_min"):
        api.query_metrics(["run-1"], ["loss"], step_min=10, step_max=1)
    with pytest.raises(ValueError, match="from_step"):
        api.query_objects(run_id="run-1", from_step=5, to_step=1)
    with pytest.raises(TypeError, match="object_id"):
        api.object_rows(True)
    with pytest.raises(ValueError, match="object_id"):
        api.object_rows(-1)


def test_query_methods_reject_invalid_response_shapes(monkeypatch):
    api = im.Api(base_url="http://example.test")

    monkeypatch.setattr(Client, "_request", lambda *args, **kwargs: {"runs": {}})
    with pytest.raises(InstantMLError, match="run query"):
        api.query_runs()

    monkeypatch.setattr(Client, "_request", lambda *args, **kwargs: {"series": {}})
    with pytest.raises(InstantMLError, match="metric series"):
        api.query_metrics(["run-1"], ["loss"])

    monkeypatch.setattr(Client, "_request", lambda *args, **kwargs: {"objects": {}})
    with pytest.raises(InstantMLError, match="object query"):
        api.query_objects(run_id="run-1")

    monkeypatch.setattr(Client, "_request", lambda *args, **kwargs: {"rows": {}})
    with pytest.raises(InstantMLError, match="object rows"):
        api.object_rows(1)


def test_query_metrics_ignores_non_object_and_empty_entries(monkeypatch):
    def fake_request(self, method, path, body=None, idempotency_key=None, retry_rate_limits=True):
        return {
            "series": [
                None,
                {"run_id": "run-1", "metrics": []},
                {"run_id": "run-2", "metrics": {"bad": True}},
                {"run_id": "run-3", "metrics": [{"step": 1, "value": 1.0}]},
            ]
        }

    monkeypatch.setattr(Client, "_request", fake_request)

    page = im.Api(base_url="http://example.test").query_metrics(["run-1", "run-2"], ["loss"])

    assert page.series == []


def test_query_objects_uses_explorer_route_and_pagination(monkeypatch):
    calls = []
    responses = [
        {"objects": [{"id": 1}], "next_cursor": "cursor-2"},
        {"objects": [{"id": 2}], "next_cursor": None},
    ]

    def fake_request(self, method, path, body=None, idempotency_key=None, retry_rate_limits=True):
        calls.append((method, path, body))
        return responses.pop(0)

    monkeypatch.setattr(Client, "_request", fake_request)

    page = im.Api(base_url="http://example.test").query_objects(
        project="cartpole",
        q="tag:review",
        kind="table",
        key="eval/samples",
        run_id="run-1",
        from_step=1,
        to_step=5,
        limit=2,
        max_pages=2,
    )

    assert page.items == [{"id": 1}, {"id": 2}]
    first_path, first_params = _parsed(calls[0][1])
    second_path, second_params = _parsed(calls[1][1])
    assert first_path == "/api/objects/explorer"
    assert second_path == "/api/objects/explorer"
    assert first_params == {
        "project": ["cartpole"],
        "q": ["tag:review"],
        "kind": ["table"],
        "key": ["eval/samples"],
        "run_id": ["run-1"],
        "from_step": ["1"],
        "to_step": ["5"],
        "limit": ["2"],
    }
    assert second_params["cursor"] == ["cursor-2"]


def test_query_objects_explorer_returns_cursor_when_max_pages_stops(monkeypatch):
    def fake_request(self, method, path, body=None, idempotency_key=None, retry_rate_limits=True):
        return {"objects": [{"id": 1}], "next_cursor": "cursor-2"}

    monkeypatch.setattr(Client, "_request", fake_request)

    page = im.Api(base_url="http://example.test").query_objects(kind="table", limit=1, max_pages=1)

    assert page.items == [{"id": 1}]
    assert page.next_cursor == "cursor-2"


def test_query_objects_falls_back_to_single_run_route_when_explorer_is_missing(monkeypatch):
    calls = []

    def fake_request(self, method, path, body=None, idempotency_key=None, retry_rate_limits=True):
        calls.append((method, path, body))
        if path.startswith("/api/objects/explorer"):
            raise InstantMLError("GET /api/objects/explorer failed: 404 not found")
        return {"objects": [{"id": 1}, {"id": 2}], "limit": 2, "offset": 0}

    monkeypatch.setattr(Client, "_request", fake_request)

    page = im.Api(base_url="http://example.test").query_objects(
        run_id="run-1",
        kind="table",
        key="eval/samples",
        limit=2,
    )

    assert page.items == [{"id": 1}, {"id": 2}]
    assert page.next_cursor == "offset:2"
    fallback_path, fallback_params = _parsed(calls[1][1])
    assert fallback_path == "/api/runs/run-1/objects"
    assert fallback_params == {
        "kind": ["table"],
        "key": ["eval/samples"],
        "limit": ["2"],
        "offset": ["0"],
    }


def test_query_objects_requires_explorer_for_cross_run_or_unpreserved_filters(monkeypatch):
    def fake_request(self, method, path, body=None, idempotency_key=None, retry_rate_limits=True):
        raise InstantMLError("GET /api/objects/explorer failed: 405 method not allowed")

    monkeypatch.setattr(Client, "_request", fake_request)
    api = im.Api(base_url="http://example.test")

    with pytest.raises(InstantMLError, match="cross-run object queries"):
        api.query_objects(kind="table")
    with pytest.raises(InstantMLError, match="cannot preserve"):
        api.query_objects(
            run_id="run-1",
            project="cartpole",
            q="tag:review",
            from_step=1,
            to_step=2,
        )


def test_query_objects_rethrows_supported_route_errors(monkeypatch):
    def fake_request(self, method, path, body=None, idempotency_key=None, retry_rate_limits=True):
        raise InstantMLError("GET /api/objects/explorer failed: 500 warehouse unavailable")

    monkeypatch.setattr(Client, "_request", fake_request)

    with pytest.raises(InstantMLError, match="warehouse unavailable"):
        im.Api(base_url="http://example.test").query_objects(run_id="run-1")


def test_query_objects_fallback_paginates_and_rejects_bad_offset_cursors(monkeypatch):
    responses = [
        InstantMLError("GET /api/objects/explorer failed: 404 not found"),
        {"objects": [{"id": 1}], "limit": 1, "offset": 0},
        {"objects": [], "limit": 1, "offset": 1},
    ]

    def fake_request(self, method, path, body=None, idempotency_key=None, retry_rate_limits=True):
        item = responses.pop(0)
        if isinstance(item, InstantMLError):
            raise item
        return item

    monkeypatch.setattr(Client, "_request", fake_request)

    page = im.Api(base_url="http://example.test").query_objects(run_id="run-1", limit=1, max_pages=2)

    assert page.items == [{"id": 1}]
    assert page.next_cursor is None

    def missing_explorer(self, method, path, body=None, idempotency_key=None, retry_rate_limits=True):
        raise InstantMLError("GET /api/objects/explorer failed: 404 not found")

    monkeypatch.setattr(Client, "_request", missing_explorer)
    api = im.Api(base_url="http://example.test")
    with pytest.raises(ValueError, match="offset"):
        api.query_objects(run_id="run-1", cursor="cursor-2")
    with pytest.raises(ValueError, match="offset"):
        api.query_objects(run_id="run-1", cursor="offset:nope")
    with pytest.raises(ValueError, match="nonnegative"):
        api.query_objects(run_id="run-1", cursor="offset:-1")

    responses = [
        InstantMLError("GET /api/objects/explorer failed: 404 not found"),
        {"objects": [{"id": 3}], "limit": 2, "offset": 2},
    ]

    def valid_offset_cursor(self, method, path, body=None, idempotency_key=None, retry_rate_limits=True):
        item = responses.pop(0)
        if isinstance(item, InstantMLError):
            raise item
        return item

    monkeypatch.setattr(Client, "_request", valid_offset_cursor)
    assert api.query_objects(run_id="run-1", cursor="offset:2", limit=2).items == [{"id": 3}]


def test_query_objects_fallback_rejects_invalid_response_shape(monkeypatch):
    responses = [
        InstantMLError("GET /api/objects/explorer failed: 404 not found"),
        {"objects": {}},
    ]

    def fake_request(self, method, path, body=None, idempotency_key=None, retry_rate_limits=True):
        item = responses.pop(0)
        if isinstance(item, InstantMLError):
            raise item
        return item

    monkeypatch.setattr(Client, "_request", fake_request)

    with pytest.raises(InstantMLError, match="per-run object"):
        im.Api(base_url="http://example.test").query_objects(run_id="run-1")


def test_object_rows_returns_bounded_page_with_offset_cursor(monkeypatch):
    calls = []

    def fake_request(self, method, path, body=None, idempotency_key=None, retry_rate_limits=True):
        calls.append((method, path, body))
        return {
            "object_id": 10,
            "rows": [
                {"row_index": 5, "row": {"prompt": "a"}},
                {"row_index": 6, "row": {"prompt": "b"}},
            ],
            "limit": 2,
            "offset": 5,
        }

    monkeypatch.setattr(Client, "_request", fake_request)

    page = im.Api(base_url="http://example.test").object_rows(10, limit=2, offset=5)

    assert page.items[0]["row"] == {"prompt": "a"}
    assert page.next_cursor == "offset:7"
    path, params = _parsed(calls[0][1])
    assert path == "/api/objects/10/rows"
    assert params == {"limit": ["2"], "offset": ["5"]}


def test_object_rows_uses_none_cursor_when_page_is_short(monkeypatch):
    def fake_request(self, method, path, body=None, idempotency_key=None, retry_rate_limits=True):
        return {"object_id": "abc", "rows": [{"row_index": 0, "row": {}}], "limit": 2, "offset": 0}

    monkeypatch.setattr(Client, "_request", fake_request)

    assert im.Api(base_url="http://example.test").object_rows("abc", limit=2).next_cursor is None


def test_private_query_url_helper_omits_empty_params():
    assert client_module._append_query("/api/example", {"q": "", "cursor": None}) == "/api/example"
