"""Alertmanager webhook sink: logs every request body as one JSON line on stdout.

Alloy ships the lines to Loki, so delivered alerts are searchable:
  {namespace="monitoring", app="alert-sink"} | json | msg="alert"
Standard library only; runs as an unprivileged user with a read-only root filesystem.
"""
import datetime
import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MAX_BODY = 4 * 1024 * 1024


def log(level, msg, **fields):
    now = datetime.datetime.now(datetime.timezone.utc)
    record = {
        "time": now.isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        "level": level,
        "msg": msg,
        "service": "alert-sink",
    }
    record.update(fields)
    print(json.dumps(record, separators=(",", ":"), sort_keys=False), flush=True)


class Handler(BaseHTTPRequestHandler):
    server_version = "alert-sink"
    sys_version = ""

    def _reply(self, code, text):
        body = (text + "\n").encode()
        self.send_response(code)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path in ("/healthz", "/readyz"):
            self._reply(200, "ok")
        else:
            self._reply(404, "not found")

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length > MAX_BODY:
            log("warn", "request body too large", path=self.path, bytes=length)
            self._reply(413, "too large")
            return
        raw = self.rfile.read(length)
        try:
            body = json.loads(raw)
        except ValueError:
            body = raw.decode("utf-8", "replace")
        log("info", "webhook received", path=self.path, bytes=length, body=body)
        if isinstance(body, dict):
            for alert in body.get("alerts", []) or []:
                labels = alert.get("labels", {}) or {}
                status = alert.get("status", "")
                log(
                    "warn" if status == "firing" else "info",
                    "alert",
                    alertname=labels.get("alertname", ""),
                    status=status,
                    severity=labels.get("severity", ""),
                    receiver=body.get("receiver", ""),
                    labels=labels,
                    annotations=alert.get("annotations", {}),
                    startsAt=alert.get("startsAt", ""),
                    endsAt=alert.get("endsAt", ""),
                    fingerprint=alert.get("fingerprint", ""),
                )
        self._reply(200, "ok")

    def log_message(self, fmt, *args):  # the JSON lines above replace the access log
        pass


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8080"))
    log("info", "listening", port=port)
    ThreadingHTTPServer(("0.0.0.0", port), Handler).serve_forever()
