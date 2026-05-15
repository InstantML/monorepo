import json
import socket
import threading
import urllib.error
import urllib.parse
import urllib.request

import pytest

from instantml_api import server as server_module
from instantml_api.server import MAX_BODY_BYTES, create_server


@pytest.fixture()
def api_server(tmp_path):
    server = create_server(tmp_path / "test.sqlite3", port=0)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    base_url = f"http://127.0.0.1:{server.server_port}"
    try:
        yield base_url
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


def request(base_url, method, path, body=None):
    data = None if body is None else json.dumps(body).encode("utf-8")
    req = urllib.request.Request(
        base_url + path,
        data=data,
        method=method,
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=2) as response:
        return json.loads(response.read().decode("utf-8"))


def test_http_lifecycle(api_server):
    assert request(api_server, "GET", "/health") == {"status": "ok"}

    project = request(api_server, "POST", "/projects", {"name": "cartpole"})["project"]
    assert request(api_server, "GET", "/projects")["projects"] == [project]

    run = request(
        api_server,
        "POST",
        "/runs",
        {"project": "cartpole", "name": "seed-1", "config": {"seed": 1}, "tags": ["rl"]},
    )["run"]
    assert run["project_id"] == project["id"]

    query = urllib.parse.urlencode({"project": "cartpole", "limit": 10, "offset": 0})
    assert request(api_server, "GET", f"/runs?{query}")["runs"][0]["id"] == run["id"]
    assert request(api_server, "GET", f"/runs/{run['id']}")["run"]["id"] == run["id"]
    assert request(api_server, "POST", f"/runs/{run['id']}/metrics", {"metrics": {"reward": 1}, "step": 0.5, "timestamp": "2026-05-09T00:00:00Z"}) == {
        "inserted": 1
    }
    metric_query = urllib.parse.urlencode({"key": "reward", "limit": 1})
    metrics = request(api_server, "GET", f"/runs/{run['id']}/metrics?{metric_query}")["metrics"]
    assert metrics[0]["value"] == 1.0
    assert metrics[0]["step"] == 0.5
    assert metrics[0]["created_at"] == "2026-05-09T00:00:00Z"
    assert request(api_server, "PATCH", f"/runs/{run['id']}", {"status": "finished"})["run"]["status"] == "finished"


@pytest.mark.parametrize(
    ("method", "path", "body", "expected"),
    [
        ("GET", "/missing", None, "route not found"),
        ("POST", "/projects", {"name": ""}, "project name"),
        ("GET", "/runs/missing", None, "run not found"),
        ("POST", "/runs/missing/metrics", {"metrics": {"x": 1}, "step": 0}, "run not found"),
        ("GET", "/runs/missing/metrics", None, "run not found"),
    ],
)
def test_http_errors(api_server, method, path, body, expected):
    with pytest.raises(urllib.error.HTTPError) as exc:
        request(api_server, method, path, body)

    payload = json.loads(exc.value.read().decode("utf-8"))
    assert expected in payload["error"]


def test_rejects_non_json_and_malformed_json(api_server):
    req = urllib.request.Request(api_server + "/projects", data=b"{}", method="POST", headers={})
    with pytest.raises(urllib.error.HTTPError) as exc:
        urllib.request.urlopen(req, timeout=2)
    assert json.loads(exc.value.read().decode("utf-8"))["error"] == "content-type must be application/json"

    req = urllib.request.Request(
        api_server + "/projects",
        data=b"{",
        method="POST",
        headers={"Content-Type": "application/json"},
    )
    with pytest.raises(urllib.error.HTTPError) as exc:
        urllib.request.urlopen(req, timeout=2)
    assert json.loads(exc.value.read().decode("utf-8"))["error"] == "request body must be valid JSON"

    req = urllib.request.Request(
        api_server + "/projects",
        data=b"[]",
        method="POST",
        headers={"Content-Type": "application/json"},
    )
    with pytest.raises(urllib.error.HTTPError) as exc:
        urllib.request.urlopen(req, timeout=2)
    assert json.loads(exc.value.read().decode("utf-8"))["error"] == "request body must be a JSON object"


def test_rejects_oversized_body(api_server):
    req = urllib.request.Request(
        api_server + "/projects",
        data=b" " * (MAX_BODY_BYTES + 1),
        method="POST",
        headers={"Content-Type": "application/json"},
    )
    with pytest.raises(urllib.error.HTTPError) as exc:
        urllib.request.urlopen(req, timeout=2)
    assert json.loads(exc.value.read().decode("utf-8"))["error"] == "request body is too large"


def test_rejects_invalid_content_length(api_server):
    parsed = urllib.parse.urlparse(api_server)
    with socket.create_connection((parsed.hostname, parsed.port), timeout=2) as sock:
        sock.sendall(
            b"POST /projects HTTP/1.1\r\n"
            + f"Host: {parsed.hostname}:{parsed.port}\r\n".encode("ascii")
            + b"Content-Type: application/json\r\n"
            + b"Content-Length: nope\r\n"
            + b"Connection: close\r\n\r\n{}"
        )
        chunks = []
        while True:
            chunk = sock.recv(4096)
            if not chunk:
                break
            chunks.append(chunk)
        response = b"".join(chunks).decode("utf-8")

    assert "400 Bad Request" in response
    assert "invalid content-length" in response


def test_internal_error_response(api_server, monkeypatch):
    def fail(_db_path):
        raise RuntimeError("boom")

    monkeypatch.setattr("instantml_api.db.list_projects", fail)
    with pytest.raises(urllib.error.HTTPError) as exc:
        request(api_server, "GET", "/projects")

    assert exc.value.code == 500
    assert json.loads(exc.value.read().decode("utf-8"))["error"] == "internal server error"


def test_run_server_closes_server(monkeypatch, tmp_path):
    events = []

    class FakeServer:
        server_port = 1234

        def serve_forever(self):
            events.append("serve")
            raise RuntimeError("stop")

        def server_close(self):
            events.append("close")

    monkeypatch.setattr(server_module, "create_server", lambda *args, **kwargs: FakeServer())

    with pytest.raises(RuntimeError, match="stop"):
        server_module.run_server(tmp_path / "test.sqlite3")

    assert events == ["serve", "close"]


def test_server_main_parses_args(monkeypatch):
    captured = {}
    monkeypatch.setattr("sys.argv", ["instantml-api", "--db", "x.sqlite3", "--host", "0.0.0.0", "--port", "9000"])
    monkeypatch.setattr(
        server_module,
        "run_server",
        lambda db_path, host, port: captured.update({"db_path": db_path, "host": host, "port": port}),
    )

    server_module.main()

    assert captured == {"db_path": "x.sqlite3", "host": "0.0.0.0", "port": 9000}
