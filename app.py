#!/usr/bin/env python3
"""
FarmaGuardia LP — servidor local + frontend estático.

Uso:
    python app.py                    # servidor en http://localhost:8000
    python app.py --port 9000        # puerto custom
    python app.py --no-browser       # no abrir el navegador
    python app.py --dump datos.json  # scrapear a JSON (sin servidor)

Endpoints:
    GET /                       → static/index.html
    GET /styles.css, /app.js    → archivos estáticos
    GET /api/farmacias          → JSON con datos (cache de 5 min)
    GET /api/farmacias?fresh=1  → fuerza re-scrape inmediato

Requisitos:  pip install -r requirements.txt
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


STATIC_DIR = Path(__file__).parent / "static"
CACHE_SECONDS = 300

# Instancia global compartida entre threads del servidor
scraper = Scraper(cache_seconds=CACHE_SECONDS)


# -------- HTTP handler -------------------------------------------------------

class Handler(BaseHTTPRequestHandler):
    # Silenciamos un poco los logs
    def log_message(self, fmt, *args):
        sys.stderr.write(f"  [{self.log_date_time_string()}] {fmt % args}\n")

    # --- helpers ---
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

    def _send_static(self, filename: str):
        """Sirve un archivo de ./static. Bloquea path traversal."""
        target = (STATIC_DIR / filename).resolve()
        if not target.is_file() or STATIC_DIR.resolve() not in target.parents:
            return self._send(b"Not found", "text/plain", status=404)

        ctype, _ = mimetypes.guess_type(target.name)
        ctype = ctype or "application/octet-stream"
        if ctype.startswith("text/") or ctype in ("application/javascript", "application/json"):
            ctype += "; charset=utf-8"
        self._send(target.read_bytes(), ctype)

    # --- routing ---
    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path

        if path in ("/", "/index.html"):
            return self._send_static("index.html")

        if path == "/api/farmacias":
            qs = parse_qs(parsed.query)
            force = bool(qs.get("fresh"))
            try:
                data = scraper.get(force=force).to_dict()
                return self._send_json(data)
            except requests.RequestException as e:
                return self._send_json({"error": f"No se pudo scrapear: {e}"}, status=502)
            except Exception as e:
                return self._send_json(
                    {"error": f"{type(e).__name__}: {e}"}, status=500
                )

        # Archivos estáticos: /styles.css, /app.js, etc.
        if path.startswith("/") and "/" not in path[1:]:
            return self._send_static(path.lstrip("/"))

        return self._send(b"Not found", "text/plain", status=404)


# -------- CLI ----------------------------------------------------------------

def _dump_to_file(path: str) -> None:
    print(f"Scrapeando {SOURCE_URL} …", flush=True)
    data = scraper.get(force=True).to_dict()
    Path(path).write_text(
        json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(f"✓ {data['count']} farmacias guardadas en {path}")
    if data["timestamp"]:
        print(f"  (publicado por el sitio: {data['timestamp']})")


def _run_server(host: str, port: int, open_browser: bool) -> None:
    print("=" * 60)
    print("  FarmaGuardia LP")
    print("=" * 60)
    print(f"  Servidor:  http://{host}:{port}")
    print(f"  Fuente:    {SOURCE_URL}")
    print(f"  Cache:     {CACHE_SECONDS}s (usá 'Refrescar' para forzar)")
    print("  Ctrl+C para detener")
    print("=" * 60)

    # Pre-calentar
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
        description="FarmaGuardia LP - scraper + servidor local",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "Ejemplos:\n"
            "  python app.py                    # servidor en http://localhost:8000\n"
            "  python app.py --port 9000        # puerto custom\n"
            "  python app.py --dump data.json   # scrapea a JSON (sin servidor)\n"
        ),
    )
    p.add_argument("--host", default="127.0.0.1", help="(default 127.0.0.1)")
    p.add_argument("--port", type=int, default=8000, help="(default 8000)")
    p.add_argument("--no-browser", action="store_true",
                   help="No abrir el navegador automáticamente")
    p.add_argument("--dump", metavar="PATH",
                   help="Scrapear y guardar en PATH como JSON, sin servidor")
    args = p.parse_args()

    if args.dump:
        _dump_to_file(args.dump)
    else:
        _run_server(args.host, args.port, open_browser=not args.no_browser)


if __name__ == "__main__":
    main()
