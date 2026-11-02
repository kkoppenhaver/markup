#!/usr/bin/env python3
"""Review server: serves a folder (or proxies a dev server) with a tldraw markup layer on top,
and receives notes from the Send button into an inbox folder that Claude Code watches.

Standard library only. Python 3.8+.

  review_server.py --root ./dist                 # static folder
  review_server.py --proxy http://localhost:3000 # wrap a running dev server
  review_server.py --root . --path /about.html --open

The review layer lives at /__review/?url=<page path>. Notes land in <inbox>/<timestamp>-<slug>.md (+ .json, .png).
"""
import argparse
import base64
import datetime as dt
import http.client
import json
import os
import re
import socketserver
import sys
import urllib.parse
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
ASSETS = os.path.join(os.path.dirname(HERE), "assets")
HOP_HEADERS = {"connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailers", "transfer-encoding", "upgrade", "content-encoding", "content-length", "accept-encoding", "host"}


def slug(s, n=40):
    s = re.sub(r"[^a-z0-9]+", "-", (s or "page").lower()).strip("-")
    return (s or "page")[:n]


class Handler(SimpleHTTPRequestHandler):
    root = os.getcwd()
    proxy = None
    inbox = None
    quiet = False

    def __init__(self, *a, **kw):
        super().__init__(*a, directory=Handler.root, **kw)

    def log_message(self, fmt, *args):
        if not Handler.quiet and not self.path.startswith("/__review/ping"):
            sys.stderr.write("%s %s\n" % (self.command, self.path))

    # ---------- routing ----------
    def do_GET(self):
        p = urllib.parse.urlsplit(self.path).path
        if p == "/__review" or p == "/__review/" or p == "/__review/index.html":
            return self.send_file(os.path.join(ASSETS, "review.html"), "text/html; charset=utf-8")
        if p == "/__review/review.js":
            return self.send_file(os.path.join(ASSETS, "review.js"), "application/javascript; charset=utf-8")
        if p == "/__review/ping":
            return self.send_json({"ok": True, "inbox": Handler.inbox, "mode": "proxy" if Handler.proxy else "static"})
        if p == "/__review/pending":
            return self.send_json({"files": sorted(f for f in os.listdir(Handler.inbox) if f.endswith(".md"))} if os.path.isdir(Handler.inbox) else {"files": []})
        if Handler.proxy:
            return self.forward()
        return super().do_GET()

    def do_HEAD(self):
        if Handler.proxy and not self.path.startswith("/__review"):
            return self.forward()
        return super().do_HEAD()

    def do_POST(self):
        p = urllib.parse.urlsplit(self.path).path
        if p == "/__review/send":
            return self.receive_notes()
        if Handler.proxy:
            return self.forward()
        self.send_error(405)

    def do_PUT(self): self.forward() if Handler.proxy else self.send_error(405)
    def do_PATCH(self): self.forward() if Handler.proxy else self.send_error(405)
    def do_DELETE(self): self.forward() if Handler.proxy else self.send_error(405)
    def do_OPTIONS(self): self.forward() if Handler.proxy else self.send_error(405)

    # ---------- helpers ----------
    def send_file(self, path, ctype):
        try:
            with open(path, "rb") as f:
                data = f.read()
        except OSError:
            return self.send_error(404)
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def send_json(self, obj, status=200):
        data = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def receive_notes(self):
        length = int(self.headers.get("Content-Length") or 0)
        try:
            payload = json.loads(self.rfile.read(length) or b"{}")
        except ValueError:
            return self.send_json({"ok": False, "error": "bad json"}, 400)
        os.makedirs(Handler.inbox, exist_ok=True)
        stamp = dt.datetime.now().strftime("%Y%m%d-%H%M%S")
        page = payload.get("url") or "/"
        base = "%s-%s" % (stamp, slug(urllib.parse.urlsplit(page).path.strip("/") or "index"))
        md_path = os.path.join(Handler.inbox, base + ".md")
        json_path = os.path.join(Handler.inbox, base + ".json")
        png_path = None
        png = payload.get("png")
        if png and png.startswith("data:image/png;base64,"):
            png_path = os.path.join(Handler.inbox, base + ".png")
            with open(png_path, "wb") as f:
                f.write(base64.b64decode(png.split(",", 1)[1]))
        with open(json_path, "w") as f:
            json.dump(payload.get("json") or {}, f, indent=2)
        header = ["<!-- markup-review notes -->", "page: " + page, "sent: " + dt.datetime.now().isoformat(timespec="seconds"), "json: " + os.path.basename(json_path)]
        if png_path:
            header.append("marks_png: " + os.path.basename(png_path) + "  (the marks alone, transparent; view it with Read)")
        with open(md_path, "w") as f:
            f.write("\n".join(header) + "\n\n" + (payload.get("markdown") or "").strip() + "\n")
        sys.stderr.write("notes -> %s\n" % md_path)
        self.send_json({"ok": True, "path": md_path})

    def forward(self):
        target = urllib.parse.urlsplit(Handler.proxy)
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else None
        headers = {k: v for k, v in self.headers.items() if k.lower() not in HOP_HEADERS}
        headers["Host"] = target.netloc
        headers["Accept-Encoding"] = "identity"
        if body is not None:
            headers["Content-Length"] = str(len(body))
        conn_cls = http.client.HTTPSConnection if target.scheme == "https" else http.client.HTTPConnection
        try:
            conn = conn_cls(target.hostname, target.port, timeout=30)
            conn.request(self.command, self.path, body=body, headers=headers)
            resp = conn.getresponse()
            data = resp.read()
        except OSError as e:
            msg = ("Review server could not reach %s (%s). Is the dev server running?" % (Handler.proxy, e)).encode()
            self.send_response(502)
            self.send_header("Content-Type", "text/plain")
            self.send_header("Content-Length", str(len(msg)))
            self.end_headers()
            self.wfile.write(msg)
            return
        self.send_response(resp.status)
        for k, v in resp.getheaders():
            if k.lower() in HOP_HEADERS:
                continue
            if k.lower() in ("x-frame-options", "content-security-policy"):
                continue  # the page must be allowed inside the review iframe (same origin)
            self.send_header(k, v)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--root", default=None, help="static folder to serve (default: current directory)")
    ap.add_argument("--proxy", default=None, help="dev server to wrap, e.g. http://localhost:3000")
    ap.add_argument("--port", type=int, default=8791)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--inbox", default=None, help="where notes land (default: ./.review/inbox under the current directory)")
    ap.add_argument("--path", default="/", help="page path to open in the review layer")
    ap.add_argument("--open", action="store_true", help="open the review URL in the default browser")
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args()

    Handler.root = os.path.abspath(args.root or os.getcwd())
    Handler.proxy = args.proxy.rstrip("/") if args.proxy else None
    Handler.inbox = os.path.abspath(args.inbox or os.path.join(os.getcwd(), ".review", "inbox"))
    Handler.quiet = args.quiet
    os.makedirs(Handler.inbox, exist_ok=True)

    socketserver.TCPServer.allow_reuse_address = True
    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    url = "http://%s:%d/__review/?url=%s" % (args.host, args.port, urllib.parse.quote(args.path, safe=""))
    print("markup-review")
    print("  serving : %s" % (Handler.proxy or Handler.root))
    print("  inbox   : %s" % Handler.inbox)
    print("  review  : %s" % url)
    sys.stdout.flush()
    if args.open:
        webbrowser.open(url)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
