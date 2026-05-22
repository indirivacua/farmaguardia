#!/usr/bin/env python3
"""FarmaGuardia LP — server local + CLI (solo dev / dump).

En producción se sirve `docs/` por GitHub Pages; este script existe para
iterar localmente y para que el workflow de Actions corra `--dump`.
"""

from __future__ import annotations

import argparse
import json
import mimetypes
import sys
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import requests

from scraper import Scraper, SOURCE_URL


STATIC_DIR = Path(__file__).parent / "docs"
CACHE_SECONDS = 300

scraper = Scraper(cache_seconds=CACHE_SECONDS)


def _is_truthy(values: list[str] | None) -> bool:
    """Trata ?fresh, ?fresh=1, ?fresh=true como sí; ?fresh=0/false como no."""
    if not values:
        return False
    return values[-1].strip().lower() not in ("0", "false", "no")


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        sys.stderr.write(f"  [{self.log_date_time_string()}] {fmt % args}\n")

    def _send(self, body: bytes, content_type: str, status: int = 200):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _send_json(self, data: dict, status: int = 200):
        body = json.dumps(data, ensure_ascii=False, indent=2).encode("utf-8")
        self._send(body, "application/json; charset=utf-8", status)

    def _send_static(self, rel_path: str):
        target = (STATIC_DIR / rel_path).resolve()
        try:
            target.relative_to(STATIC_DIR.resolve())
        except ValueError:
            return self._send(b"Not found", "text/plain", status=404)
        if not target.is_file():
            return self._send(b"Not found", "text/plain", status=404)

        ctype, _ = mimetypes.guess_type(target.name)
        ctype = ctype or "application/octet-stream"
        if ctype.startswith("text/") or ctype in ("application/javascript", "application/json"):
            ctype += "; charset=utf-8"
        self._send(target.read_bytes(), ctype)

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path

        if path in ("/", "/index.html"):
            return self._send_static("index.html")

        if path == "/api/farmacias":
            qs = parse_qs(parsed.query)
            force = _is_truthy(qs.get("fresh"))
            try:
                return self._send_json(scraper.get(force=force).to_dict())
            except requests.RequestException as e:
                return self._send_json({"error": f"No se pudo scrapear: {e}"}, status=502)
            except Exception as e:
                return self._send_json(
                    {"error": f"{type(e).__name__}: {e}"}, status=500
                )

        rel = path.lstrip("/")
        if rel:
            return self._send_static(rel)
        return self._send(b"Not found", "text/plain", status=404)


def _dump_to_file(path: str) -> None:
    print(f"Scrapeando {SOURCE_URL} …", flush=True)
    data = scraper.get(force=True).to_dict()
    out = Path(path)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"✓ {data['count']} farmacias guardadas en {path}")
    if data["timestamp"]:
        print(f"  (publicado por el sitio: {data['timestamp']})")


def _run_server(host: str, port: int, open_browser: bool) -> None:
    bar = "=" * 60
    print(f"{bar}\n  FarmaGuardia LP\n{bar}")
    print(f"  Servidor:  http://{host}:{port}")
    print(f"  Fuente:    {SOURCE_URL}")
    print(f"  Cache:     {CACHE_SECONDS}s (usá 'Refrescar' para forzar)")
    print(f"  Ctrl+C para detener\n{bar}")

    print("\n  Scrapeando datos iniciales…", end=" ", flush=True)
    try:
        data = scraper.get(force=True)
        print(f"✓ {len(data.pharmacies)} farmacias ({data.timestamp})")
    except Exception as e:
        print(f"⚠ {type(e).__name__}: {e}")
        print("  (El servidor arranca igual; se reintentará al abrir la página)")

    server = ThreadingHTTPServer((host, port), Handler)
    if open_browser:
        webbrowser.open(f"http://{host}:{port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n\n  Saliendo…")
        server.shutdown()


def main():
    p = argparse.ArgumentParser(
        description="FarmaGuardia LP — scraper + servidor local",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "Ejemplos:\n"
            "  python app.py                                # servidor en http://localhost:8000\n"
            "  python app.py --port 9000\n"
            "  python app.py --dump docs/data/farmacias.json\n"
        ),
    )
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, default=8000)
    p.add_argument("--no-browser", action="store_true",
                   help="No abrir el navegador automáticamente")
    p.add_argument("--dump", metavar="PATH",
                   help="Scrapear a PATH como JSON y salir, sin servidor")
    args = p.parse_args()

    if args.dump:
        _dump_to_file(args.dump)
    else:
        _run_server(args.host, args.port, open_browser=not args.no_browser)


if __name__ == "__main__":
    main()
