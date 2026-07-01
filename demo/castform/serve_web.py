#!/usr/bin/env python3
"""Serve the Castform demo parent page locally."""

from __future__ import annotations

import argparse
import functools
import http.server
import socketserver
from pathlib import Path


HERE = Path(__file__).resolve().parent
WEB_DIR = HERE / "web"


class DemoHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self) -> None:
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        super().end_headers()


class ReusableTCPServer(socketserver.TCPServer):
    allow_reuse_address = True


def main() -> int:
    parser = argparse.ArgumentParser(description="Serve the Castform demo web page")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=5174)
    args = parser.parse_args()

    handler = functools.partial(DemoHandler, directory=str(WEB_DIR))
    with ReusableTCPServer((args.host, args.port), handler) as httpd:
        print(f"Serving Castform demo page at http://{args.host}:{args.port}")
        print("For hosted iframes, expose this port through an HTTPS tunnel and pass that origin to run_demo.py.")
        httpd.serve_forever()


if __name__ == "__main__":
    raise SystemExit(main())
