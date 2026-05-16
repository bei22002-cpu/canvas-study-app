#!/usr/bin/env python3
"""
Canvas API Proxy — solves CORS when loading canvas-app.html from the browser.

Run: python canvas-proxy.py

If file:// fails to reach the proxy (some browsers tighten local access), serve the folder:

  python -m http.server 8080 --bind 127.0.0.1

Then open http://127.0.0.1:8080/canvas-app.html

Environment variables:
  CANVAS_PROXY_HOST  (default 127.0.0.1)
  CANVAS_PROXY_PORT  (default 3001)
"""
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import Request, urlopen
import json
import os

LISTEN_HOST = os.environ.get("CANVAS_PROXY_HOST", "127.0.0.1")
LISTEN_PORT = int(os.environ.get("CANVAS_PROXY_PORT", "3001"))


class ProxyHandler(BaseHTTPRequestHandler):

    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        try:
            print("  " + (fmt % args if args else fmt), flush=True)
        except Exception:
            pass

    def send_cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header(
            "Access-Control-Allow-Headers",
            "Authorization, X-Canvas-Domain, Content-Type",
        )

    def send_json(self, code, obj):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_cors()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_cors()
        self.end_headers()

    def do_GET(self):
        raw_path = urlparse(self.path).path
        norm = raw_path.rstrip("/") or "/"

        if norm == "/proxy-health":
            return self.send_json(
                200,
                {"ok": True, "service": "canvas-proxy", "port": LISTEN_PORT},
            )

        domain = self.headers.get("X-Canvas-Domain", "").strip()
        auth = self.headers.get("Authorization", "").strip()

        if domain.startswith(("https://", "http://")):
            domain = urlparse(domain).netloc.split(":")[0] or domain

        if not domain or not auth:
            return self.send_json(
                400,
                {"error": "Missing X-Canvas-Domain or Authorization header"},
            )

        safe_path = self.path if self.path.startswith("/") else "/" + self.path
        target = "https://%s%s" % (domain, safe_path)
        req = Request(target, headers={"Authorization": auth, "Accept": "application/json"})

        try:
            with urlopen(req, timeout=30) as resp:
                body = resp.read()
                self.send_response(resp.status)
                self.send_cors()
                self.send_header(
                    "Content-Type",
                    resp.headers.get("Content-Type", "application/json"),
                )
                link_hdr = resp.headers.get("Link", "")
                if link_hdr:
                    self.send_header("Link", link_hdr)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
        except HTTPError as e:
            chunk = e.read() if hasattr(e, "read") else b"{}"
            self.send_response(e.code)
            self.send_cors()
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(chunk)))
            self.end_headers()
            self.wfile.write(chunk)
        except URLError as e:
            err = str(e.reason) if e.reason is not None else repr(e)
            print("  [Canvas upstream failed] %s" % err)
            return self.send_json(502, {"error": err, "target": target})


if __name__ == "__main__":
    addr = (LISTEN_HOST, LISTEN_PORT)
    httpd = HTTPServer(addr, ProxyHandler)
    base = "http://%s:%s" % (LISTEN_HOST, LISTEN_PORT)
    print("\n  Canvas proxy at %s" % base)
    print("  Health check: %s/proxy-health" % base)
    print("  Open canvas-app.html (file or http://127.0.0.1:8080/ if you run http.server).")
    print("  Ctrl+C to stop.\n")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n  Stopped.")
