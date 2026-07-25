# FarmaGuardia LP

App single-page que muestra las farmacias de turno en La Plata (Argentina)
con mapa interactivo. Los datos se scrapean desde
[colfarmalp.org.ar/turnos-la-plata](https://www.colfarmalp.org.ar/turnos-la-plata/)
y se sirven como sitio **100% estático** — sin backend en producción.

## Características

- **Mapa interactivo** con pins color-codeados por zona (La Plata / Norte /
  Los Hornos); los chips de filtro hacen de referencia de colores.
- **Filtros** por zona y búsqueda libre por nombre o calle.
- **Sincronización mapa ↔ lista**: tocar una tarjeta centra el mapa; tocar un
  pin resalta la tarjeta.
- **Geolocalización opcional** (off por defecto). Al activarla:
  - Muestra tu posición en el mapa con un círculo de precisión.
  - Calcula y muestra la distancia a cada farmacia.
  - Ordena la lista por cercanía.
  - Si ya está activa, un tap centra el mapa en tu ubicación.
  - Long-press sobre el botón la desactiva.
- **Navegación tipo GPS** hasta la farmacia más cercana, con la ruta dibujada
  sobre el mapa y recálculo automático (ver abajo).
- **Bottom-sheet** en mobile con 3 estados (expanded / peek / hidden),
  arrastrable con el dedo. El alto del estado "peek" se mide en runtime a
  partir del bloque de stats + filtros, así nunca corta los chips de zona.
- **Sin botón de refrescar**: el JSON cambia 3 veces por día, así que la app
  lo recarga sola al volver a la pestaña si pasaron más de 15 minutos.

## Navegación

Con la ubicación activa se traza sola una ruta caminando hasta la farmacia
más cercana. El botón de la flecha en el header la prende y apaga; el botón
"Ruta" de cualquier tarjeta o popup fija un destino puntual.

La tarjeta de navegación son tres líneas —destino / distancia + ETA /
próxima maniobra— y toda la tarjeta es el botón de "centrar la ruta". Cuando
hay un destino fijado a mano aparece un chip "más cercana" para volver al
modo automático.

La ruta se reajusta en tres situaciones distintas:

| Situación | Qué pasa |
|---|---|
| Avanzás sobre la ruta | Se recorta el tramo recorrido y se actualizan distancia, ETA y próxima maniobra. Sin pedidos de red. |
| Te desviás más de 45 m | Se pide una ruta nueva desde donde estás. |
| Otra farmacia queda más cerca | Cambia el destino y se recalcula. También cuando cambian los filtros o llegan datos nuevos. |

El cambio de destino tiene histéresis (la nueva candidata tiene que estar un
20% y al menos 80 m más cerca): sin eso, dos farmacias casi equidistantes se
turnarían el primer puesto con cada rebote del GPS. La lista de farmacias se
reordena por cercanía con el mismo watcher de posición.

### Ruteo

Se rutea contra instancias públicas de **OSRM**, sin API key ni build step:

1. `routing.openstreetmap.de/routed-foot` — perfil peatonal (FOSSGIS).
2. `router.project-osrm.org` — perfil auto, solo de backup. Con este perfil la
   ETA se recalcula a paso de peatón (1.35 m/s) en vez de usar la que
   devuelve OSRM.
3. Si las dos fallan, se dibuja la línea recta al destino, marcada como
   aproximada en la tarjeta.

Las dos hablan la misma API v5, así que el parseo es el mismo. Son servicios
comunitarios gratuitos: hay un cooldown de 8 s entre pedidos y, mientras sigas
sobre la ruta, el avance se calcula localmente proyectando tu posición sobre
la polilínea — no se le pide nada al router. Las constantes están todas
juntas en `NAV` (arriba de `docs/app.js`).

## Cómo funciona

El sitio del Colegio de Farmacéuticos **no tiene CORS** habilitado, así que
no se puede scrapear directo desde el browser. La solución es hacerlo en
**build time** en vez de runtime:

```mermaid
flowchart LR
    A[colfarmalp.org.ar]
    B[scraper.py]
    C[GitHub Actions<br/>cron 3×/día]
    D[docs/data/<br/>farmacias.json]
    E[GitHub Pages<br/>sirve docs/]
    F[🌐 Browser]

    C -->|ejecuta| B
    A -->|HTTP scrape| B
    B -->|genera| D
    D -->|git commit| E
    E -->|fetch| F
```

Un workflow corre el scraper, commitea el JSON actualizado, y GitHub Pages lo
sirve junto con el frontend estático. El browser hace
`fetch('data/farmacias.json')` y listo — sin servidor, sin CORS, gratis.

### Frecuencia de scraping

El turno **empieza a las 08:30 y termina a las 08:30 del día siguiente**, así
que los datos cambian una vez por día. El cron corre 3 veces:

| UTC | Hora Argentina | Por qué |
|---|---|---|
| 11:40 | 08:40 | Arranca el turno nuevo |
| 16:40 | 13:40 | Por si el sitio publicó tarde o corrigió la lista |
| 23:40 | 20:40 | Última pasada antes de la noche |

Los minutos `:40` son a propósito: el scheduler de Actions se demora más
cuanto más cerca de la hora en punto se lo agenda.

## Estructura

```
farmaguardia/
├── scraper.py                      # Lógica de scraping (pura, sin server)
├── app.py                          # Server local + CLI (solo dev / dump)
├── requirements.txt
├── README.md
├── .github/workflows/scrape.yml    # Cron de scraping (3 corridas diarias)
└── docs/                           # ← lo que sirve GitHub Pages
    ├── index.html
    ├── styles.css
    ├── app.js
    └── data/
        ├── .gitkeep
        └── farmacias.json          # generado por el workflow
```

## Deploy en GitHub Pages

1. **Settings → Pages**: source = `Deploy from a branch`, branch = `main`,
   folder = **`/docs`** → Save.
2. **Settings → Actions → General → Workflow permissions**: marcá
   **"Read and write permissions"**. Sin esto el job corre verde pero el
   commit nunca llega al repo.
3. **Actions → "Scrape farmacias" → Run workflow** para generar el JSON
   inicial (o esperá a la próxima corrida del cron).

### Notas de implementación

Detalles del setup que explican por qué algunas cosas están como están:

- **Las rutas del HTML son relativas** (`href="styles.css"`, no
  `href="/styles.css"`). Las absolutas rompen al servir desde un subpath tipo
  `usuario.github.io/proyecto/` o desde un dominio custom con subdirectorio.
- **`docs/data/` tiene que existir** antes de correr `--dump`, porque
  `Path.write_text()` no crea carpetas padre. De ahí el `.gitkeep` y el
  `Path(path).parent.mkdir(parents=True, exist_ok=True)` de `_dump_to_file`.
- **Los ids de farmacia salen de nombre + dirección**, no del índice del
  array: así el destino de la ruta y la tarjeta seleccionada sobreviven a un
  refresh de los datos aunque cambie el orden o la cantidad de farmacias.
- **Los commits de datos los firma `github-actions[bot]`** (autor y
  committer), vía `commit_author` en el workflow. Por defecto la action usa
  `github.actor` como autor, que es el dueño del repo.

## Desarrollo local

Para iterar sobre el frontend o el scraper con datos en vivo:

```bash
pip install -r requirements.txt
python app.py
```

Levanta un servidor en `http://localhost:8000` que sirve el frontend desde
`docs/` y expone `/api/farmacias` con cache de 5 min. Cambios al HTML/CSS/JS
se ven con un refresh.

### Opciones de CLI

```bash
python app.py --port 9000                       # cambiar puerto
python app.py --host 0.0.0.0                    # accesible desde la LAN
python app.py --no-browser                      # no abrir navegador
python app.py --dump docs/data/farmacias.json   # solo scrapear a JSON
```

El último es el que usa el workflow de Actions — podés correrlo local para
testear el scraper sin levantar el server.

### Usar desde el celular en la misma red

```bash
python app.py --host 0.0.0.0
```

Después, desde el celular, abrí `http://<ip-de-tu-compu>:8000`.

**Geolocalización en LAN**: `navigator.geolocation` solo funciona sobre
`http://localhost` o conexiones `https://`. Para probar ubicación y
navegación desde el celular en LAN hay que exponerlo por HTTPS (p. ej. con
`ngrok http 8000` o `tailscale funnel`). En producción no es problema porque
GitHub Pages ya sirve por HTTPS.

## Usar el scraper como librería

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

El sitio a veces publica coordenadas rotas (`destination=0,0`, o una longitud
cargada en el campo de latitud). El frontend las filtra con un bounding box
del Gran La Plata (`LP_BOUNDS` en `docs/app.js`): esas farmacias aparecen en
la lista con un aviso, pero no en el mapa ni como destino de ruta.

## Licencia

Uso libre. Respetá los términos del sitio scrapeado y de las instancias
públicas de OSRM.
