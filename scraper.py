"""
scraper.py — Scrapea farmacias de turno desde colfarmalp.org.ar.

La página NO tiene API pública, así que parseamos su HTML con BeautifulSoup.

Selectores usados (basados en la estructura actual del sitio):
    .content.farmacias h1 > span        → timestamp publicado
    .turnos > .tr  (salvo los de .thead) → una fila por farmacia
        td[0]  → nombre        (quita <span>Farmacia</span>)
        td[1]  → dirección     (quita <span>Dirección</span>)
        td[2]  → zona          (quita <span>Zona</span>)
        td[3]  → teléfono      (quita <span>Teléfono</span>)
        td[4] a[href]          → URL Google Maps con ?destination=lat,lng
    .turneros a[href$='.pdf']            → PDFs del turnero por zona

Si cambia la estructura del sitio, ajustá `parse_html()`.
"""

from __future__ import annotations

import re
import time
from dataclasses import dataclass, asdict, field
from datetime import datetime
from typing import Optional

import requests
from bs4 import BeautifulSoup, Tag


SOURCE_URL = "https://www.colfarmalp.org.ar/turnos-la-plata/"
REQUEST_TIMEOUT = 20

# User-Agent realista; algunos sitios bloquean el default de requests
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/122.0.0.0 Safari/537.36"
)

_COORD_RE = re.compile(r"destination=(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)")
_WS_RE = re.compile(r"\s+")


# -------- Data classes -------------------------------------------------------

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
    timestamp: str           # El que publica el sitio, ej. "21/4/2026 a las: 18:27 horas"
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


# -------- Parsing ------------------------------------------------------------

def _clean_td(td: Tag) -> str:
    """Texto de un .td sin los <span> de etiqueta y con espacios normalizados."""
    copy = BeautifulSoup(str(td), "html.parser")
    for s in copy.find_all("span"):
        s.decompose()
    return _WS_RE.sub(" ", copy.get_text(" ", strip=True)).strip()


def _parse_coords(href: str) -> Optional[tuple[float, float]]:
    m = _COORD_RE.search(href)
    if not m:
        return None
    return float(m.group(1)), float(m.group(2))


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
    """Parsea el HTML de la página de turnos y devuelve un ScrapeResult."""
    soup = BeautifulSoup(html, "html.parser")

    # Timestamp publicado por el sitio
    timestamp = ""
    h1 = soup.select_one(".content.farmacias h1")
    if h1 and (span := h1.select_one("span")):
        timestamp = span.get_text(strip=True)

    # Farmacias: todas las .tr dentro de .turnos que NO estén en un .thead
    pharmacies: list[Pharmacy] = []
    if (turnos := soup.select_one(".turnos")):
        for row in turnos.find_all("div", class_="tr"):
            if row.find_parent(class_="thead"):
                continue
            if (ph := _parse_row(row)):
                pharmacies.append(ph)

    # PDFs del turnero por zona
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


# -------- Fetch + cache ------------------------------------------------------

class Scraper:
    """
    Scraper con cache en memoria.

    Uso:
        scraper = Scraper(cache_seconds=300)
        data = scraper.get()            # usa cache si es fresca
        data = scraper.get(force=True)  # fuerza re-scrape
    """

    def __init__(self, url: str = SOURCE_URL, cache_seconds: int = 300):
        self.url = url
        self.cache_seconds = cache_seconds
        self._cache: Optional[ScrapeResult] = None
        self._cached_at: float = 0.0

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

    def get(self, force: bool = False) -> ScrapeResult:
        now = time.time()
        if not force and self._cache and (now - self._cached_at < self.cache_seconds):
            return self._cache
        html = self._fetch()
        result = parse_html(html)
        self._cache = result
        self._cached_at = now
        return result

    @property
    def cache_age(self) -> Optional[float]:
        """Segundos desde el último scrape, o None si nunca se hizo."""
        if not self._cache:
            return None
        return time.time() - self._cached_at
