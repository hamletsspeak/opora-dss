#!/usr/bin/env python3
"""Minimal HTTP /analyze for Klar Python MCDM (stdlib only)."""

from __future__ import annotations

import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Dict
from urllib.parse import urlparse

from mcdm.core import is_analysis_ready, run_robust_mcdm
from mcdm.fixture import experiment_supplier_session

HOST = os.environ.get("KLAR_PY_HOST", "127.0.0.1")
PORT = int(os.environ.get("KLAR_PY_PORT", "8790"))


class Handler(BaseHTTPRequestHandler):
    def _cors(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def _json(self, code: int, payload: Dict[str, Any]) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self._cors()
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self) -> None:  # noqa: N802
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        if path == "/health":
            self._json(200, {"ok": True, "backend": "python"})
            return
        if path == "/experiment":
            self._json(200, {"session": experiment_supplier_session()})
            return
        self._json(404, {"error": "not found"})

    def do_POST(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b"{}"
        try:
            body = json.loads(raw.decode("utf-8") or "{}")
        except json.JSONDecodeError:
            self._json(400, {"error": "invalid JSON"})
            return

        if path != "/analyze":
            self._json(404, {"error": "not found"})
            return

        session = body.get("session")
        if not session or not is_analysis_ready(session):
            self._json(
                400,
                {
                    "error": "Недостаточно данных: нужны ≥2 критерия и ≥2 альтернативы с оценками"
                },
            )
            return

        samples = body.get("samples", 2000)
        seed = body.get("seed", 42)
        try:
            samples = max(1, min(10_000, int(samples)))
            seed = int(seed)
        except (TypeError, ValueError):
            self._json(400, {"error": "samples/seed must be integers"})
            return

        analysis = run_robust_mcdm(session, samples=samples, seed=seed)
        audit = {
            "id": f"py_{seed}_{samples}",
            "ts": __import__("time").time_ns() // 1_000_000,
            "session": session,
            "mcdmParams": analysis["mcdmParams"],
            "ranking": analysis["ranking"],
            "methods": analysis["methods"],
            "agreement": analysis["agreement"],
            "explanation": analysis["sensitivityNote"],
            "sensitivityNote": analysis["sensitivityNote"],
            "weightMeans": analysis["weightMeans"],
            "samples": analysis["samples"],
        }
        self._json(
            200,
            {
                "analysis": analysis,
                "explanation": analysis["sensitivityNote"],
                "audit": audit,
                "backend": "python",
            },
        )

    def log_message(self, fmt: str, *args: Any) -> None:
        print(f"[klar-py] {self.address_string()} {fmt % args}")


def main() -> None:
    httpd = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"Klar Python MCDM on http://{HOST}:{PORT}  (POST /analyze)")
    httpd.serve_forever()


if __name__ == "__main__":
    main()
