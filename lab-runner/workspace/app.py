"""Small deterministic checkout workload; faults are in Kubernetes configuration."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import time


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        ok = self.path in ("/", "/health", "/checkout")
        body = json.dumps({"service": "checkout", "status": "ok" if ok else "not_found", "version": "v1"}).encode()
        self.send_response(200 if ok else 404)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, _fmt, *_args):
        print(json.dumps({"time": time.time(), "service": "checkout", "method": self.command, "path": self.path}), flush=True)


ThreadingHTTPServer(("0.0.0.0", 8080), Handler).serve_forever()
