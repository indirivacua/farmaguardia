# FarmaGuardia LP

App single-page que muestra las farmacias de turno en La Plata (Argentina)
con mapa interactivo. Los datos se scrapean **en vivo** desde
[colfarmalp.org.ar/turnos-la-plata](https://www.colfarmalp.org.ar/turnos-la-plata/).

Pensada para usarse tanto en desktop como en el celular (responsive real, no
"mobile = apretar todo y rezar").

## Características

- **Mapa interactivo** con pins color-codeados por zona (La Plata / Norte /
  Los Hornos).
- **Filtros** por zona y búsqueda libre por nombre o calle.
- **Sincronización mapa ↔ lista**: tocar una tarjeta centra el mapa; tocar un
  pin resalta la tarjeta.
- **Geolocalización opcional** (off por defecto). Al activarla:
  - Muestra tu posición en el mapa con un círculo de precisión.
  - Calcula y muestra la distancia a cada farmacia.
  - Ordena la lista por cercanía.
  - Si ya está activa, un tap centra el mapa en tu ubicación.
  - Long-press sobre el botón la desactiva.
- **Mobile**: el panel de farmacias es un bottom-sheet arrastrable con 3
  estados (expanded / peek / hidden), igual que apps de mapas nativas.
- Botón de **refrescar** que re-scrapea el sitio en vivo.

## Estructura

```
farmaguardia/
├── app.py              # Servidor HTTP + CLI
├── scraper.py          # Lógica de scraping (aislada, testeable)
├── requirements.txt
├── README.md
└── static/
    ├── index.html
    ├── styles.css
    └── app.js
```

## Requisitos

- Python 3.9+

```bash
pip install -r requirements.txt
```

## Uso

```bash
python app.py
```

Esto:

1. Scrapea la web del Colegio de Farmacéuticos de La Plata.
2. Levanta un servidor local en `http://localhost:8000`.
3. Abre el navegador.

### Opciones de CLI

```bash
python app.py --port 9000            # cambiar puerto
python app.py --host 0.0.0.0         # accesible desde otros dispositivos de la LAN
python app.py --no-browser           # no abrir navegador
python app.py --dump datos.json      # scrapear a JSON (sin servidor)
```

### Usar desde el celular en la misma red

```bash
python app.py --host 0.0.0.0
```

Después, desde el celular, abrí `http://<ip-de-tu-compu>:8000`.

**Nota sobre geolocalización en LAN**: la API `navigator.geolocation` solo
funciona sobre `http://localhost` o conexiones `https://`. Si querés usar
la geolocalización desde el celular conectado por LAN, necesitás
exponerlo por HTTPS (p. ej. con `ngrok http 8000` o `tailscale funnel`).

## Endpoints

| Ruta                          | Descripción                           |
|-------------------------------|---------------------------------------|
| `GET /`                       | `static/index.html`                   |
| `GET /styles.css`, `/app.js`  | Archivos estáticos                    |
| `GET /api/farmacias`          | JSON con datos (cache de 5 min)       |
| `GET /api/farmacias?fresh=1`  | Fuerza re-scrape inmediato            |

## Uso del scraper como librería

```python
from scraper import Scraper

sc = Scraper(cache_seconds=300)
result = sc.get()
for p in result.pharmacies:
    print(p.name, p.address, p.lat, p.lng)
```

## Sobre el scraping

Ver `scraper.py`. Se parsea con BeautifulSoup usando los selectores:

- `.content.farmacias h1 > span` → timestamp publicado
- `.turnos > .tr` (excluyendo los de `.thead`) → cada fila
  - `.td[0..3]` → nombre, dirección, zona, teléfono
  - `.td[4] a[href]` → URL de Google Maps con `?destination=lat,lng`
- `.turneros a[href$='.pdf']` → PDFs del turnero por zona

Si el sitio cambia su estructura HTML, ajustá los selectores en
`scraper.py` (función `parse_html`).

## Por qué hace falta el servidor Python

La página del Colegio no expone CORS, así que un `fetch()` desde el
navegador falla con error cross-origin. El servidor local actúa como
proxy: hace el request del lado del servidor y le devuelve JSON al
frontend.

## Licencia

Uso libre. Respetá los términos del sitio scrapeado; el cache de 5
minutos está justamente para no martillar a `colfarmalp.org.ar`.
