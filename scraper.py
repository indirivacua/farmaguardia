"""scraper.py — Scrapea farmacias de turno desde colfarmalp.org.ar.

El sitio no tiene API: parseamos HTML con BeautifulSoup. Si cambia la
estructura, ajustar `parse_html()`.
"""

from __future__ import annotations

import re
import threading
import time
from dataclasses import asdict, dataclass, field
from datetime import datetime
from typing import Optional

import requests
from bs4 import BeautifulSoup, Tag


SOURCE_URL = "https://www.colfarmalp.org.ar/turnos-la-plata/"
REQUEST_TIMEOUT = 20

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/122.0.0.0 Safari/537.36"
)

_COORD_RE = re.compile(r"destination=(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)")
_WS_RE = re.compile(r"\s+")


@dataclass
class Pharmacy:
    name: str
    address: str
    zone: str
    phone: str
    lat: float
    lng: float

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class ScrapeResult:
    timestamp: str           # tal cual lo publica el sitio
    scraped_at: str          # ISO-8601 con timezone local
    source: str
    pharmacies: list[Pharmacy] = field(default_factory=list)
    pdfs: list[dict] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "timestamp": self.timestamp,
            "scraped_at": self.scraped_at,
            "source": self.source,
            "count": len(self.pharmacies),
            "pharmacies": [p.to_dict() for p in self.pharmacies],
            "pdfs": self.pdfs,
        }


def _clean_td(td: Tag) -> str:
    """Texto de un .td sin sus <span> de etiqueta y con whitespace normalizado."""
    copy = BeautifulSoup(str(td), "html.parser")
    for s in copy.find_all("span"):
        s.decompose()
    return _WS_RE.sub(" ", copy.get_text(" ", strip=True)).strip()


def _parse_coords(href: str) -> Optional[tuple[float, float]]:
    m = _COORD_RE.search(href)
    return (float(m.group(1)), float(m.group(2))) if m else None


def _parse_row(row: Tag) -> Optional[Pharmacy]:
    tds = row.find_all("div", class_="td", recursive=False)
    if len(tds) < 5:
        return None

    a = tds[4].find("a", href=True)
    coords = _parse_coords(a["href"]) if a else None
    if not coords:
        return None

    name = _clean_td(tds[0])
    if not name:
        return None

    return Pharmacy(
        name=name,
        address=_clean_td(tds[1]),
        zone=_clean_td(tds[2]),
        phone=_clean_td(tds[3]),
        lat=coords[0],
        lng=coords[1],
    )


def parse_html(html: str) -> ScrapeResult:
    soup = BeautifulSoup(html, "html.parser")

    timestamp = ""
    h1 = soup.select_one(".content.farmacias h1")
    if h1 and (span := h1.select_one("span")):
        timestamp = span.get_text(strip=True)

    pharmacies: list[Pharmacy] = []
    if (turnos := soup.select_one(".turnos")):
        for row in turnos.find_all("div", class_="tr"):
            if row.find_parent(class_="thead"):
                continue
            if (ph := _parse_row(row)):
                pharmacies.append(ph)

    pdfs = [
        {
            "label": _WS_RE.sub(" ", a.get_text(" ", strip=True)).strip(),
            "url": a["href"],
        }
        for a in soup.select(".turneros a[href$='.pdf']")
    ]

    return ScrapeResult(
        timestamp=timestamp,
        scraped_at=datetime.now().astimezone().isoformat(timespec="seconds"),
        source=SOURCE_URL,
        pharmacies=pharmacies,
        pdfs=pdfs,
    )


class Scraper:
    """Scrape + cache en memoria. Thread-safe.

    >>> sc = Scraper(cache_seconds=300)
    >>> data = sc.get()              # usa cache si está fresca
    >>> data = sc.get(force=True)    # ignora la cache
    """

    def __init__(self, url: str = SOURCE_URL, cache_seconds: int = 300):
        self.url = url
        self.cache_seconds = cache_seconds
        self._cache: Optional[ScrapeResult] = None
        self._cached_at: float = 0.0
        self._lock = threading.Lock()

    def _fetch(self) -> str:
        r = requests.get(
            self.url,
            headers={
                "User-Agent": USER_AGENT,
                "Accept": "text/html,application/xhtml+xml",
                "Accept-Language": "es-AR,es;q=0.9,en;q=0.8",
            },
            timeout=REQUEST_TIMEOUT,
        )
        r.raise_for_status()
        r.encoding = r.apparent_encoding or "utf-8"
        return r.text

    def _is_fresh(self) -> bool:
        return (
            self._cache is not None
            and (time.time() - self._cached_at) < self.cache_seconds
        )

    def get(self, force: bool = False) -> ScrapeResult:
        if not force and self._is_fresh():
            return self._cache  # type: ignore[return-value]

        # Doble check con lock para evitar dobles fetches concurrentes
        with self._lock:
            if not force and self._is_fresh():
                return self._cache  # type: ignore[return-value]
            self._cache = parse_html(self._fetch())
            self._cached_at = time.time()
            return self._cache

    @property
    def cache_age(self) -> Optional[float]:
        if self._cache is None:
            return None
        return time.time() - self._cached_at
