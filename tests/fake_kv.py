"""A stand-in for the plat-kv Cloudflare Worker, for tests/tasks_grid.py. Stdlib only.

  GET  /kv/<key>         -> {ok, key, value}
  PUT  /kv/<key>         -> replaces the whole value; requires X-Plat-Token: test-token
  POST /__fail?n=<n>     -> the next n PUTs answer 500 (to exercise the retry queue)
  GET  /__stats          -> {"puts": n}

Usage: python tests/fake_kv.py <port> <seed.json>   (seed maps key -> value)
"""
import json
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlparse

TOKEN = "test-token"
DATA: dict = {}
STATE = {"fail": 0, "puts": 0}
LOCK = threading.Lock()


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass

    def do_GET(self):
        u = urlparse(self.path)
        if u.path == "/__stats":
            return self._send(200, {"puts": STATE["puts"]})
        if u.path.startswith("/kv/"):
            key = unquote(u.path[4:])
            with LOCK:
                return self._send(200, {"ok": True, "key": key, "value": DATA.get(key)})
        self._send(404, {"ok": False, "error": "not found"})

    def do_PUT(self):
        u = urlparse(self.path)
        if not u.path.startswith("/kv/"):
            return self._send(404, {"ok": False, "error": "not found"})
        if self.headers.get("X-Plat-Token") != TOKEN:
            return self._send(401, {"ok": False, "error": "unauthorized"})
        raw = self.rfile.read(int(self.headers.get("Content-Length") or 0))
        with LOCK:
            if STATE["fail"] > 0:
                STATE["fail"] -= 1
                return self._send(500, {"ok": False, "error": "simulated failure"})
            try:
                value = json.loads(raw.decode("utf-8"))
            except ValueError:
                return self._send(400, {"ok": False, "error": "bad json"})
            key = unquote(u.path[4:])
            DATA[key] = value
            STATE["puts"] += 1
            return self._send(200, {"ok": True, "key": key, "savedAt": "now", "savedBy": "test", "via": "token"})

    def do_POST(self):
        u = urlparse(self.path)
        if u.path == "/__fail":
            STATE["fail"] = int(parse_qs(u.query).get("n", ["1"])[0])
            return self._send(200, {"ok": True})
        self._send(404, {"ok": False, "error": "not found"})


if __name__ == "__main__":
    port = int(sys.argv[1])
    if len(sys.argv) > 2:
        with open(sys.argv[2], encoding="utf-8") as fh:
            DATA.update(json.load(fh))
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
