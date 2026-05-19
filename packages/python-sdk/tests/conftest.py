import pytest


@pytest.fixture(autouse=True)
def _default_credentials(monkeypatch):
    """Default INSTANTML_API_KEY for tests that incidentally call init().
    PR #39 added fail-fast on missing credentials; tests that specifically
    test credential resolution override via their own monkeypatch.delenv.
    """
    monkeypatch.setenv("INSTANTML_API_KEY", "test")
