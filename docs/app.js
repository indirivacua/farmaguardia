/* FarmaGuardia LP — frontend (Leaflet + vanilla JS) */

// --- Config ---
const ZONE_COLORS = {
  'La Plata':   '#0f4c3a',
  'Norte':      '#5b8fb5',
  'Los Hornos': '#e94f3a',
};
const DEFAULT_COLOR = '#0f4c3a';
const MOBILE_BREAKPOINT = 820;
const DEFAULT_CENTER = [-34.92, -57.96];
const DEFAULT_ZOOM = 13;
const DATA_URL = 'data/farmacias.json';
const POS_REFRESH_THRESHOLD_M = 10;   // umbral para re-renderizar la lista en watchPosition

// --- Navegación ---
// Ruteo contra instancias públicas de OSRM (misma API v5 en las dos, así que
// el parseo es idéntico). La de FOSSGIS tiene perfil peatonal — que es el que
// importa acá — y el demo de OSRM queda de backup por si está caída.
const NAV = {
  PROVIDERS: [
    { profile: 'foot',    base: 'https://routing.openstreetmap.de/routed-foot' },
    { profile: 'driving', base: 'https://router.project-osrm.org' },
  ],
  REQUEST_TIMEOUT_MS: 12_000,
  MIN_REQUEST_MS: 8_000,   // cooldown entre llamadas al router
  OFF_ROUTE_M: 45,         // separación de la ruta que dispara recálculo
  REFRESH_MOVE_M: 250,     // refresco periódico aunque sigas sobre la ruta
  ARRIVED_M: 25,           // radio para dar el viaje por terminado
  RESUME_M: 120,           // si te alejás de una llegada, se reanuda
  // Histéresis al elegir destino: sin esto, dos farmacias casi equidistantes
  // se turnarían el "más cercana" con cada jitter del GPS.
  SWITCH_RATIO: 0.8,
  SWITCH_MIN_M: 80,
  WALK_MPS: 1.35,          // ~4.9 km/h, para estimar ETA con perfiles no peatonales
};

// --- DOM helpers ---
const $ = (sel) => document.querySelector(sel);

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'
  }[c]));
}

function cleanPhone(p) {
  const first = String(p || '').split(/[\/,]/)[0].trim();
  return first.replace(/[^\d+]/g, '');
}

const isMobile = () => window.innerWidth <= MOBILE_BREAKPOINT;

function slugify(s) {
  return String(s ?? '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '').slice(0, 60);
}

// Los ids salen de nombre + dirección, no del índice del array: así el destino
// de la ruta y la card seleccionada sobreviven a un refresh de los datos aunque
// cambie el orden o la cantidad de farmacias de turno.
function withStableIds(list) {
  const seen = new Map();
  return list.map((p) => {
    const base = slugify(`${p.name}-${p.address}`) || 'farmacia';
    const n = (seen.get(base) || 0) + 1;
    seen.set(base, n);
    return { ...p, id: n > 1 ? `${base}-${n}` : base, distance: null };
  });
}

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
            Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function formatDistance(meters) {
  if (meters == null) return '';
  if (meters < 1000) return `${Math.round(meters)} m`;
  return `${(meters / 1000).toFixed(meters < 10000 ? 1 : 0)} km`;
}

// Filtra lat/lng inválidas. El sitio del Colegio a veces publica coords rotas:
// `destination=0,0` (sin dato) o valores cargados mal (p. ej. una longitud en
// el campo de latitud), que caen en el océano y arrastran todo el viewport.
// En vez del rango global usamos un bounding box del Gran La Plata: cubre las
// tres zonas (La Plata / Norte / Los Hornos) y descarta cualquier cosa afuera.
const LP_BOUNDS = { latMin: -35.10, latMax: -34.75, lngMin: -58.20, lngMax: -57.75 };
function hasValidCoords(f) {
  const lat = Number(f.lat);
  const lng = Number(f.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
  if (lat === 0 || lng === 0) return false;
  return (
    lat >= LP_BOUNDS.latMin && lat <= LP_BOUNDS.latMax &&
    lng >= LP_BOUNDS.lngMin && lng <= LP_BOUNDS.lngMax
  );
}

// --- State ---
const state = {
  pharmacies: [],
  filter: 'all',
  search: '',
  activeId: null,
  userLocation: null,
  nav: {
    active: false,      // hay navegación en curso
    dismissed: false,   // el usuario cerró la tarjeta: no auto-arrancar de nuevo
    targetId: null,     // farmacia hacia la que se está ruteando
    pinnedId: null,     // destino fijado a mano (si es null, seguimos a la más cercana)
    route: null,        // ruta calculada (ver buildRoute)
    loading: false,
    arrived: false,
  },
};

// --- Toast ---
const Toast = (() => {
  const el = $('#toast');
  let hideTimer;
  function show(msg, { isError = false, duration = 3500 } = {}) {
    clearTimeout(hideTimer);
    el.textContent = msg;
    el.classList.toggle('err', isError);
    el.classList.add('show');
    hideTimer = setTimeout(() => el.classList.remove('show'), duration);
  }
  return { show };
})();

// --- Shared HTML fragments ---
const SVG_PHONE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg>';
const SVG_PIN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>';

function callButton(phone, label) {
  return `<a class="pharma-btn call" href="tel:${cleanPhone(phone)}" data-stop>${SVG_PHONE}${escapeHtml(label)}</a>`;
}
const SVG_NAV = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="3 11 22 2 13 21 11 13 3 11"/></svg>';

function routeButton(f, label) {
  if (!hasValidCoords(f)) return '';
  return `<button class="pharma-btn" data-stop data-route-to="${f.id}">${SVG_NAV}${escapeHtml(label)}</button>`;
}

function goButton(f, label) {
  if (hasValidCoords(f)) {
    return `<a class="pharma-btn" target="_blank" rel="noopener" data-stop href="https://www.google.com/maps/dir/?api=1&destination=${f.lat},${f.lng}">${SVG_PIN}${escapeHtml(label)}</a>`;
  }
  // Coords no confiables (sitio cargó mal el dato): en vez de mandar al océano
  // o deshabilitar el botón, buscamos por nombre + dirección y dejamos que
  // Google geocodifique. La farmacia es real, solo le falta la coord.
  const q = encodeURIComponent(`${f.name}, ${f.address}, La Plata, Argentina`);
  return `<a class="pharma-btn" target="_blank" rel="noopener" data-stop href="https://www.google.com/maps/search/?api=1&query=${q}">${SVG_PIN}${escapeHtml(label)}</a>`;
}

// --- Map ---
const MapView = (() => {
  const map = L.map('map', {
    center: DEFAULT_CENTER, zoom: DEFAULT_ZOOM, zoomControl: true, tap: true,
  });

  L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> · © <a href="https://carto.com/attributions">CARTO</a>',
    subdomains: 'abcd',
    maxZoom: 19,
  }).addTo(map);

  const markers = new Map();
  const routeLayer = L.layerGroup().addTo(map);
  let userMarker = null;
  let userCircle = null;
  let targetId = null;

  function pinHTML(color) {
    return `<div class="pin">
      <svg viewBox="0 0 36 44" xmlns="http://www.w3.org/2000/svg">
        <path d="M18 2C9.7 2 3 8.6 3 17c0 10 15 25 15 25s15-15 15-25c0-8.4-6.7-15-15-15z"
              fill="${color}" stroke="#0a1a1a" stroke-width="2.2" stroke-linejoin="round"/>
        <path d="M15 10h6v5h5v6h-5v5h-6v-5h-5v-6h5v-5z"
              fill="#f7e07a" stroke="#0a1a1a" stroke-width="1.2" stroke-linejoin="round"/>
      </svg>
    </div>`;
  }

  function popupHTML(f) {
    const dist = f.distance != null
      ? `<div style="margin-top:4px;font-family:Fraunces,serif;font-style:italic;font-size:12px;color:#0f4c3a">A ${formatDistance(f.distance)} de tu ubicación</div>`
      : '';
    return `
      <div>
        <div class="popup-name">${escapeHtml(f.name)}</div>
        <div class="popup-addr">${escapeHtml(f.address)}<br/><strong>${escapeHtml(f.zone)}</strong>${dist}</div>
        <div class="popup-actions">${callButton(f.phone, 'Llamar')}${routeButton(f, 'Ruta acá')}${goButton(f, 'Maps')}</div>
      </div>`;
  }

  function rebuild(pharmacies, onSelect) {
    markers.forEach(m => map.removeLayer(m));
    markers.clear();

    for (const f of pharmacies) {
      if (!hasValidCoords(f)) continue;   // sin marker; igual aparece en la lista con aviso
      const icon = L.divIcon({
        className: 'custom-pin',
        html: pinHTML(ZONE_COLORS[f.zone] || DEFAULT_COLOR),
        iconSize: [36, 44],
        iconAnchor: [18, 42],
        popupAnchor: [0, -40],
      });
      const marker = L.marker([f.lat, f.lng], { icon, title: f.name })
        .bindPopup(popupHTML(f), { closeButton: false, offset: [0, -6] })
        .on('click', () => onSelect(f.id, { fromMarker: true }));
      marker.addTo(map);
      markers.set(f.id, marker);
    }

    highlight(state.activeId);   // los markers son nuevos: reponemos active/target
    fitToVisibleMarkers();
  }

  function updatePopups(pharmaciesById) {
    markers.forEach((marker, id) => {
      const f = pharmaciesById.get(id);
      if (f) marker.setPopupContent(popupHTML(f));
    });
  }

  function filterVisible(visibleIds) {
    markers.forEach((marker, id) => {
      const shouldShow = visibleIds.has(id);
      const isShown = map.hasLayer(marker);
      if (shouldShow && !isShown) marker.addTo(map);
      else if (!shouldShow && isShown) map.removeLayer(marker);
    });
    fitToVisibleMarkers();
  }

  function fitToVisibleMarkers() {
    // Con una ruta en curso el viewport lo maneja Nav: reencuadrar sobre todos
    // los pins te sacaría del camino cada vez que llegan datos nuevos.
    if (state.nav.route) return;

    const layers = [];
    markers.forEach(m => { if (map.hasLayer(m)) layers.push(m); });
    if (userMarker) layers.push(userMarker);
    if (layers.length === 0) return;

    try {
      const group = L.featureGroup(layers);
      map.flyToBounds(group.getBounds(), { padding: [60, 60], duration: 0.6, maxZoom: 15 });
    } catch {
      map.setView(DEFAULT_CENTER, DEFAULT_ZOOM);
    }
  }

  function highlight(activeId) {
    markers.forEach((marker, id) => {
      const el = marker.getElement();
      const pin = el && el.querySelector('.pin');
      if (!pin) return;
      pin.classList.toggle('active', id === activeId);
      pin.classList.toggle('target', id === targetId);
    });
  }

  function setTarget(id) {
    targetId = id;
    highlight(state.activeId);
  }

  function flyTo(f) {
    if (!hasValidCoords(f)) return;
    map.flyTo([f.lat, f.lng], Math.max(map.getZoom(), 16), { duration: 0.6 });
    setTimeout(() => markers.get(f.id)?.openPopup(), 400);
  }

  function setUserLocation(location) {
    // Mover el marker existente en vez de recrearlo: durante la navegación esto
    // corre con cada tick del GPS y recrear el DOM reinicia la animación.
    if (location && userMarker) {
      const latlng = [location.lat, location.lng];
      userMarker.setLatLng(latlng);
      if (location.accuracy && location.accuracy < 2000) {
        if (userCircle) {
          userCircle.setLatLng(latlng).setRadius(location.accuracy);
        } else {
          userCircle = accuracyCircle(latlng, location.accuracy).addTo(map);
        }
      } else if (userCircle) {
        map.removeLayer(userCircle);
        userCircle = null;
      }
      return;
    }

    if (userMarker) { map.removeLayer(userMarker); userMarker = null; }
    if (userCircle) { map.removeLayer(userCircle); userCircle = null; }
    if (!location) return;

    const icon = L.divIcon({
      className: 'user-pin',
      html: '<div class="user-dot"></div>',
      iconSize: [20, 20],
      iconAnchor: [10, 10],
    });
    userMarker = L.marker([location.lat, location.lng], {
      icon, title: 'Tu ubicación', zIndexOffset: 1000
    }).addTo(map);
    userMarker.bindPopup('<div class="popup-name">Tu ubicación</div>', { closeButton: false });

    if (location.accuracy && location.accuracy < 2000) {
      userCircle = accuracyCircle([location.lat, location.lng], location.accuracy).addTo(map);
    }
  }

  function accuracyCircle(latlng, accuracy) {
    return L.circle(latlng, {
      radius: accuracy,
      color: '#3b82f6',
      fillColor: '#3b82f6',
      fillOpacity: 0.08,
      weight: 1,
    });
  }

  function flyToUser() {
    if (!userMarker) return;
    map.flyTo(userMarker.getLatLng(), Math.max(map.getZoom(), 15), { duration: 0.6 });
  }

  // --- Ruta ---
  // Tres trazos: lo ya caminado en punteado tenue, y lo que falta con un
  // "casing" oscuro debajo del trazo claro para que se lea sobre cualquier tile.
  function drawRoute(traveled, remaining, { approx = false } = {}) {
    routeLayer.clearLayers();
    if (traveled.length > 1) {
      L.polyline(traveled, {
        color: '#0a1a1a', weight: 4, opacity: 0.3,
        dashArray: '2 9', lineCap: 'round',
      }).addTo(routeLayer);
    }
    if (remaining.length > 1) {
      L.polyline(remaining, {
        color: '#0a1a1a', weight: 10, opacity: 0.9,
        lineCap: 'round', lineJoin: 'round',
      }).addTo(routeLayer);
      L.polyline(remaining, {
        color: '#f7e07a', weight: 5, opacity: 1,
        lineCap: 'round', lineJoin: 'round',
        dashArray: approx ? '10 9' : null,
      }).addTo(routeLayer);
    }
  }

  function clearRoute() {
    routeLayer.clearLayers();
  }

  function fitRoute(coords) {
    if (!coords || coords.length < 2) return;
    try {
      map.flyToBounds(L.latLngBounds(coords), {
        padding: [70, 70], duration: 0.7, maxZoom: 17,
      });
    } catch { /* bounds degenerados: dejamos el viewport como está */ }
  }

  return {
    rebuild, updatePopups, filterVisible, highlight, flyTo, setTarget,
    fitToVisibleMarkers, setUserLocation, flyToUser,
    drawRoute, clearRoute, fitRoute,
    invalidateSize: () => map.invalidateSize(),
  };
})();

// --- List ---
const ListView = (() => {
  const listEl    = $('#list');
  const countEl   = $('#stat-count');
  const labelEl   = $('#stat-filtered');
  const metaEl    = $('#source-meta');
  const fabCount  = $('#fab-list-count');

  function filtered() {
    const q = state.search.trim().toLowerCase();
    const list = state.pharmacies.filter(f => {
      if (state.filter !== 'all' && f.zone !== state.filter) return false;
      if (q && !(f.name.toLowerCase().includes(q) || f.address.toLowerCase().includes(q))) return false;
      return true;
    });
    if (state.userLocation) {
      list.sort((a, b) => (a.distance ?? Infinity) - (b.distance ?? Infinity));
    }
    return list;
  }

  function cardHTML(f, idx) {
    const color = ZONE_COLORS[f.zone] || DEFAULT_COLOR;
    const invalid = !hasValidCoords(f);

    const distHtml = f.distance != null
      ? `<span class="pharma-distance">${formatDistance(f.distance)}</span>`
      : `<div class="pharma-num">Nº ${String(idx + 1).padStart(2, '0')}</div>`;

    const warnHtml = invalid
      ? `<div class="pharma-warn">No se puede mostrar en el mapa porque la dirección no se pudo ubicar. Revisá la dirección o llamá antes de ir.</div>`
      : '';

    const routing = state.nav.active && state.nav.targetId === f.id;
    const routingTag = routing ? '<span class="pharma-routing-tag">En ruta</span>' : '';

    const ariaLabel = `${f.name}, ${f.address}, zona ${f.zone}`;
    const activeCls = state.activeId === f.id ? 'active' : '';
    const invalidCls = invalid ? 'no-coords' : '';
    const routingCls = routing ? 'routing' : '';

    return `
      <article class="pharma ${invalidCls} ${activeCls} ${routingCls}"
               data-id="${f.id}" tabindex="0" role="button"
               aria-label="${escapeHtml(ariaLabel)}">
        <div class="pharma-head">
          <div class="pharma-name">${escapeHtml(f.name)}${routingTag}</div>
          ${distHtml}
        </div>
        <div class="pharma-addr">${escapeHtml(f.address)}</div>
        ${warnHtml}
        <div class="pharma-meta">
          <span class="zone-tag">
            <span class="dot" style="background:${color}"></span>
            ${escapeHtml(f.zone)}
          </span>
          <div class="pharma-actions">
            ${callButton(f.phone, f.phone)}
            ${routeButton(f, 'Ruta')}
            ${goButton(f, 'Maps')}
          </div>
        </div>
      </article>`;
  }

  function render() {
    const list = filtered();
    countEl.textContent = list.length;
    labelEl.textContent = state.filter === 'all' ? 'farmacias' : state.filter;
    fabCount.textContent = list.length;

    if (state.pharmacies.length === 0) return;

    if (list.length === 0) {
      listEl.innerHTML = '<div class="state-msg"><span class="big">∅</span>Sin resultados.<br/>Probá otros filtros o términos.</div>';
      return;
    }

    listEl.innerHTML = list.map(cardHTML).join('');
  }

  function setMeta(meta) {
    const published = meta.timestamp || '';
    const scraped = meta.scraped_at ? new Date(meta.scraped_at) : null;
    const time = scraped ? scraped.toLocaleTimeString('es-AR', {
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      timeZone: 'America/Argentina/Buenos_Aires',
    }) : '—';
    metaEl.innerHTML = `
      ${published ? `Publicado por el sitio: <strong>${escapeHtml(published)}</strong><br/>` : ''}
      Scrapeado a las ${time} ·
      <a href="${meta.source}" target="_blank" rel="noopener">fuente</a>
    `;
  }

  function showError(msg, onRetry) {
    listEl.innerHTML = `
      <div class="state-msg err">
        <span class="big">!</span>
        No se pudo cargar los datos.<br/>
        <small>${escapeHtml(msg)}</small>
        <br/><button id="retry-btn">Reintentar</button>
      </div>`;
    $('#retry-btn').addEventListener('click', onRetry);
    countEl.textContent = '!';
  }

  function showLoading(msg) {
    listEl.innerHTML = `<div class="state-msg"><span class="big">⏳</span>${escapeHtml(msg)}</div>`;
  }

  function scrollToActive() {
    const active = listEl.querySelector('.pharma.active');
    if (active) active.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  // Event delegation: un solo listener para click + keyboard activation
  function bindActivation(onSelect) {
    const activate = (card) => {
      if (!card) return;
      onSelect(card.dataset.id, { fromList: true });
    };
    listEl.addEventListener('click', (e) => {
      if (e.target.closest('[data-stop]')) return;   // botones internos (llamar / ir)
      activate(e.target.closest('.pharma'));
    });
    listEl.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const card = e.target.closest('.pharma');
      if (!card || document.activeElement !== card) return;
      e.preventDefault();
      activate(card);
    });
  }

  return { render, setMeta, showError, showLoading, scrollToActive, filtered, bindActivation };
})();

// --- Bottom sheet (mobile) ---
const BottomSheet = (() => {
  const sidebar = $('#sidebar');
  const handle = $('#sheet-handle');

  function setState(newState) {
    if (!['expanded', 'peek', 'hidden'].includes(newState)) return;
    sidebar.dataset.state = newState;
    setTimeout(() => MapView.invalidateSize(), 350);
  }
  const currentState = () => sidebar.dataset.state || 'expanded';

  let startY = 0;
  let startTransform = 0;
  let dragging = false;

  function onPointerDown(e) {
    if (!isMobile()) return;
    dragging = true;
    sidebar.classList.add('dragging');
    startY = e.touches ? e.touches[0].clientY : e.clientY;
    startTransform = new DOMMatrix(getComputedStyle(sidebar).transform).m42;
    e.preventDefault();
  }

  function onPointerMove(e) {
    if (!dragging) return;
    const y = e.touches ? e.touches[0].clientY : e.clientY;
    const newTransform = Math.max(0, startTransform + (y - startY));
    sidebar.style.transform = `translateY(${newTransform}px)`;
  }

  function onPointerUp() {
    if (!dragging) return;
    dragging = false;
    sidebar.classList.remove('dragging');
    sidebar.style.transform = '';

    // Snap al estado más cercano según dónde quedó el top del sheet
    const topFromViewport = sidebar.getBoundingClientRect().top;
    const vh = window.innerHeight;
    if (topFromViewport < vh * 0.35)       setState('expanded');
    else if (topFromViewport < vh * 0.78)  setState('peek');
    else                                    setState('hidden');
  }

  handle.addEventListener('touchstart', onPointerDown, { passive: false });
  handle.addEventListener('touchmove', onPointerMove, { passive: false });
  handle.addEventListener('touchend', onPointerUp);
  handle.addEventListener('touchcancel', onPointerUp);

  handle.addEventListener('click', () => {
    if (!isMobile()) return;
    const next = { expanded: 'peek', peek: 'hidden', hidden: 'expanded' };
    setState(next[currentState()] || 'peek');
  });

  return { setState, currentState };
})();

// --- Distance helpers (top-level: usados por Geo y por loadData) ---
function computeDistances() {
  if (!state.userLocation) {
    state.pharmacies.forEach(f => { f.distance = null; });
    return;
  }
  const { lat, lng } = state.userLocation;
  state.pharmacies.forEach(f => {
    f.distance = hasValidCoords(f) ? haversine(lat, lng, f.lat, f.lng) : null;
  });
}

function refreshAfterLocationChange() {
  computeDistances();
  const byId = new Map(state.pharmacies.map(p => [p.id, p]));
  MapView.updatePopups(byId);
  ListView.render();
}

// --- Geolocation ---
const Geo = (() => {
  const btn = $('#btn-locate');
  let watchId = null;

  const setActive = (active) => {
    btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    btn.title = active ? 'Ocultar mi ubicación' : 'Mostrar mi ubicación';
  };
  const setLoading = (loading) => {
    btn.classList.toggle('locating', loading);
    btn.disabled = loading;
  };

  function applyPosition(pos, { rerender = true } = {}) {
    state.userLocation = {
      lat: pos.coords.latitude,
      lng: pos.coords.longitude,
      accuracy: pos.coords.accuracy,
    };
    MapView.setUserLocation(state.userLocation);
    if (rerender) refreshAfterLocationChange();
    Nav.onPositionChange();
  }

  function startWatch() {
    watchId = navigator.geolocation.watchPosition(
      (p) => {
        const prev = state.userLocation;
        const moved = !prev || haversine(prev.lat, prev.lng, p.coords.latitude, p.coords.longitude) >= POS_REFRESH_THRESHOLD_M;
        // El punto y el avance de la ruta se actualizan siempre; reordenar y
        // repintar la lista entera solo vale la pena si te moviste de verdad.
        applyPosition(p, { rerender: moved });
      },
      () => { /* ignoramos errores transitorios del watch */ },
      { enableHighAccuracy: true, maximumAge: 60_000, timeout: 30_000 }
    );
  }

  function enable() {
    if (!navigator.geolocation) {
      Toast.show('Tu navegador no soporta geolocalización', { isError: true });
      return;
    }
    setLoading(true);
    Toast.show('Pidiendo permiso de ubicación…');

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLoading(false);
        setActive(true);
        applyPosition(pos);
        MapView.fitToVisibleMarkers();
        Toast.show('Ubicación activa · lista ordenada por cercanía');
        startWatch();
        Nav.autoStart();
      },
      (err) => {
        setLoading(false);
        setActive(false);
        const msgs = {
          1: 'Permiso de ubicación denegado',
          2: 'Ubicación no disponible',
          3: 'Timeout buscando ubicación',
        };
        Toast.show(msgs[err.code] || 'No se pudo obtener la ubicación', { isError: true });
      },
      { enableHighAccuracy: true, maximumAge: 30_000, timeout: 15_000 }
    );
  }

  function disable() {
    if (watchId != null) {
      navigator.geolocation.clearWatch(watchId);
      watchId = null;
    }
    state.userLocation = null;
    setActive(false);
    Nav.stop();
    MapView.setUserLocation(null);
    refreshAfterLocationChange();
    Toast.show('Ubicación desactivada');
  }

  const toggle = () => state.userLocation ? disable() : enable();

  function recomputeForNewData() {
    if (state.userLocation) computeDistances();
  }

  // Click: si ya hay ubicación, centra. Si no, la activa.
  btn.addEventListener('click', () => {
    if (state.userLocation) MapView.flyToUser();
    else toggle();
  });

  // Long-press (700ms) para desactivar
  let pressTimer;
  btn.addEventListener('pointerdown', () => {
    if (!state.userLocation) return;
    pressTimer = setTimeout(disable, 700);
  });
  btn.addEventListener('pointerup', () => clearTimeout(pressTimer));
  btn.addEventListener('pointerleave', () => clearTimeout(pressTimer));

  return { enable, disable, toggle, recomputeForNewData };
})();

// --- Navegación paso a paso ---
// Ruta dibujada sobre el mapa hacia la farmacia más cercana, que se reajusta
// sola: avanza localmente con cada tick del GPS, vuelve a pedirle el camino al
// router si te desviás, y cambia de destino si otra farmacia pasa a ser la más
// cercana (con histéresis para no oscilar entre dos casi equidistantes).
const Nav = (() => {
  const mapWrap    = $('.map-wrap');
  const card       = $('#route-card');
  const badgeEl    = $('#route-badge');
  const targetEl   = $('#route-target');
  const statsEl    = $('#route-stats');
  const stepEl     = $('#route-step');
  const btnToggle  = $('#btn-route');
  const btnClose   = $('#route-close');
  const btnCenter  = $('#route-recenter');
  const btnNearest = $('#route-nearest');

  let inFlight = false;
  let dirty = false;             // llegó un sync mientras había un pedido en vuelo
  let lastRequestAt = 0;
  let cooldownTimer = null;
  let routeFrom = null;          // posición desde la que se calculó la ruta actual
  let fitOnNextRoute = false;

  // ---- Traducción de maniobras de OSRM ----
  const MODIFIER_ES = {
    'left': 'a la izquierda',
    'right': 'a la derecha',
    'slight left': 'levemente a la izquierda',
    'slight right': 'levemente a la derecha',
    'sharp left': 'cerrado a la izquierda',
    'sharp right': 'cerrado a la derecha',
    'straight': 'derecho',
    'uturn': 'en U',
  };

  function stepText(step) {
    const { type, modifier } = step.maneuver || {};
    const dir = MODIFIER_ES[modifier] || '';
    const road = step.name ? ` por ${step.name}` : '';
    switch (type) {
      case 'depart':      return `Arrancá${road}`;
      case 'arrive':      return 'Llegás a destino';
      case 'turn':        return `Girá ${dir}${road}`.replace('  ', ' ');
      case 'new name':    return `Seguí${road}`;
      case 'continue':    return `Seguí ${dir || 'derecho'}${road}`;
      case 'fork':        return `Mantenete ${dir || 'derecho'}${road}`;
      case 'merge':       return `Incorporate${road}`;
      case 'end of road': return `Al final de la calle girá ${dir}`;
      case 'roundabout':
      case 'rotary':      return `Tomá la rotonda${road}`;
      case 'roundabout turn': return `En la rotonda salí ${dir}${road}`;
      default:            return `Seguí${road}`;
    }
  }

  // ---- Router ----
  async function fetchRoute(from, to) {
    for (const p of NAV.PROVIDERS) {
      const url = `${p.base}/route/v1/${p.profile}/` +
                  `${from.lng},${from.lat};${to.lng},${to.lat}` +
                  '?overview=full&geometries=geojson&steps=true&alternatives=false';
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), NAV.REQUEST_TIMEOUT_MS);
      try {
        const r = await fetch(url, { signal: ctrl.signal });
        if (!r.ok) continue;
        const data = await r.json();
        if (data.code !== 'Ok' || !data.routes || !data.routes.length) continue;
        return buildRoute(data.routes[0], p.profile);
      } catch {
        // timeout, red caída o instancia con problemas: probamos la siguiente
      } finally {
        clearTimeout(timer);
      }
    }
    return null;
  }

  // Normaliza la respuesta de OSRM: coords [lat,lng], distancias acumuladas por
  // vértice (para saber cuánto llevás recorrido) y maniobras con su posición.
  function buildRoute(raw, profile) {
    const coords = raw.geometry.coordinates.map(([lng, lat]) => [lat, lng]);
    const cum = [0];
    for (let i = 1; i < coords.length; i++) {
      cum[i] = cum[i - 1] + haversine(coords[i - 1][0], coords[i - 1][1], coords[i][0], coords[i][1]);
    }
    const distance = cum[cum.length - 1] || raw.distance || 0;

    const steps = [];
    let at = 0;
    for (const s of (raw.legs && raw.legs[0] ? raw.legs[0].steps : [])) {
      steps.push({ at, text: stepText(s) });
      at += s.distance || 0;
    }

    return {
      coords, cum, steps, distance,
      // El perfil de auto se usa solo como backup: la ETA la recalculamos a
      // paso de peatón para no prometer un tiempo que no aplica.
      duration: profile === 'foot' ? raw.duration : distance / NAV.WALK_MPS,
      approx: false,
    };
  }

  // Sin router disponible mostramos la recta, avisando que es aproximada.
  function straightRoute(from, to) {
    const distance = haversine(from.lat, from.lng, to.lat, to.lng);
    return {
      coords: [[from.lat, from.lng], [to.lat, to.lng]],
      cum: [0, distance],
      steps: [{ at: 0, text: 'Ruta directa: no se pudo calcular el camino por calle' }],
      distance,
      duration: distance / NAV.WALK_MPS,
      approx: true,
    };
  }

  // ---- Geometría ----
  // Proyecta la posición sobre la polilínea con una aproximación plana
  // (metros por grado a esta latitud): a escala de ciudad el error es nulo y
  // evita hacer haversine por segmento en cada tick del GPS.
  function projectOnRoute(route, lat, lng) {
    const mPerLat = 111320;
    const mPerLng = 111320 * Math.cos(lat * Math.PI / 180);
    const px = lng * mPerLng;
    const py = lat * mPerLat;

    let best = { dist: Infinity, index: 0, along: 0, point: route.coords[0] };
    for (let i = 0; i < route.coords.length - 1; i++) {
      const [aLat, aLng] = route.coords[i];
      const [bLat, bLng] = route.coords[i + 1];
      const ax = aLng * mPerLng, ay = aLat * mPerLat;
      const dx = bLng * mPerLng - ax, dy = bLat * mPerLat - ay;
      const len2 = dx * dx + dy * dy;
      const t = len2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
      const dist = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
      if (dist < best.dist) {
        best = {
          dist,
          index: i,
          along: route.cum[i] + t * (route.cum[i + 1] - route.cum[i]),
          point: [aLat + t * (bLat - aLat), aLng + t * (bLng - aLng)],
        };
      }
    }
    return best;
  }

  function nextStep(route, along) {
    for (const s of route.steps) {
      if (s.at > along + 5) return { text: s.text, in: s.at - along };
    }
    return null;
  }

  // ---- Destino ----
  function pickTarget() {
    if (state.nav.pinnedId != null) {
      const pinned = state.pharmacies.find(p => p.id === state.nav.pinnedId);
      return pinned && hasValidCoords(pinned) ? pinned : null;
    }

    // Candidatas = lo que estás viendo en la lista (respeta zona y búsqueda).
    const list = ListView.filtered().filter(hasValidCoords);
    if (!list.length) return null;

    const nearest = list.reduce((a, b) =>
      (a.distance ?? Infinity) <= (b.distance ?? Infinity) ? a : b);

    const current = list.find(p => p.id === state.nav.targetId);
    if (!current || current.id === nearest.id) return current || nearest;

    const dCur = current.distance ?? Infinity;
    const dNew = nearest.distance ?? Infinity;
    const clearlyCloser = dNew < dCur * NAV.SWITCH_RATIO && (dCur - dNew) > NAV.SWITCH_MIN_M;
    return clearlyCloser ? nearest : current;
  }

  // ---- Ciclo principal ----
  function sync({ force = false } = {}) {
    if (!state.nav.active || !state.userLocation) return;

    const target = pickTarget();
    if (!target) {
      state.nav.targetId = null;
      state.nav.route = null;
      routeFrom = null;
      MapView.clearRoute();
      MapView.setTarget(null);
      render({ empty: true });
      return;
    }

    const changed = target.id !== state.nav.targetId;
    if (changed) {
      state.nav.targetId = target.id;
      state.nav.route = null;
      state.nav.arrived = false;
      routeFrom = null;
      fitOnNextRoute = true;
      MapView.setTarget(target.id);
      MapView.clearRoute();
      ListView.render();
    }

    const { lat, lng } = state.userLocation;
    const toTarget = haversine(lat, lng, target.lat, target.lng);
    if (toTarget <= NAV.ARRIVED_M) state.nav.arrived = true;
    else if (state.nav.arrived && toTarget > NAV.RESUME_M) state.nav.arrived = false;

    if (state.nav.arrived) {
      // Soltamos la ruta: ya no hay nada que dibujar y el mapa vuelve a
      // encuadrar solo. Si te alejás de nuevo se pide una nueva.
      state.nav.route = null;
      routeFrom = null;
      MapView.clearRoute();
      render({ target, arrived: true });
      return;
    }

    const route = state.nav.route;
    if (route && !changed && !force) {
      const proj = projectOnRoute(route, lat, lng);
      const drift = routeFrom ? haversine(routeFrom.lat, routeFrom.lng, lat, lng) : Infinity;
      if (proj.dist <= NAV.OFF_ROUTE_M && drift < NAV.REFRESH_MOVE_M) {
        // Seguís sobre la ruta: la recortamos y actualizamos números sin
        // molestar al router. Esto es lo que corre en la mayoría de los ticks.
        paint(route, proj);
        render({ target, proj });
        return;
      }
    }

    requestRoute(target);
  }

  function requestRoute(target) {
    if (inFlight) { dirty = true; return; }

    const wait = NAV.MIN_REQUEST_MS - (Date.now() - lastRequestAt);
    if (wait > 0) {
      clearTimeout(cooldownTimer);
      cooldownTimer = setTimeout(() => sync({ force: true }), wait + 50);
      render({ target, loading: true });
      return;
    }

    const from = { lat: state.userLocation.lat, lng: state.userLocation.lng };
    const to = { lat: target.lat, lng: target.lng };
    inFlight = true;
    lastRequestAt = Date.now();
    state.nav.loading = true;
    render({ target, loading: true });

    fetchRoute(from, to)
      .catch(() => null)
      .then((route) => {
        inFlight = false;
        state.nav.loading = false;

        // Mientras viajaba el pedido pudo cambiar el destino o terminar la
        // navegación: en ese caso la respuesta ya no sirve.
        if (!state.nav.active || state.nav.targetId !== target.id) return;

        state.nav.route = route || straightRoute(from, to);
        routeFrom = from;
        if (!route) Toast.show('No se pudo calcular el camino: te muestro la línea recta', { isError: true });

        const proj = projectOnRoute(state.nav.route, state.userLocation.lat, state.userLocation.lng);
        paint(state.nav.route, proj);
        render({ target, proj });

        if (fitOnNextRoute) {
          fitOnNextRoute = false;
          MapView.fitRoute(state.nav.route.coords);
        }
      })
      .finally(() => {
        inFlight = false;
        if (dirty) { dirty = false; sync({ force: true }); }
      });
  }

  function paint(route, proj) {
    const traveled = route.coords.slice(0, proj.index + 1).concat([proj.point]);
    const remaining = [proj.point].concat(route.coords.slice(proj.index + 1));
    MapView.drawRoute(traveled, remaining, { approx: route.approx });
  }

  // ---- Tarjeta ----
  function formatEta(seconds) {
    const min = Math.max(1, Math.round(seconds / 60));
    if (min < 60) return `${min} min caminando`;
    return `${Math.floor(min / 60)} h ${min % 60} min caminando`;
  }

  function render({ target = null, proj = null, loading = false, arrived = false, empty = false } = {}) {
    if (!state.nav.active) return;
    card.hidden = false;
    mapWrap.classList.add('navigating');
    btnNearest.hidden = state.nav.pinnedId == null;

    if (empty) {
      card.classList.remove('approx');
      badgeEl.textContent = 'Sin destino';
      targetEl.textContent = 'Ninguna farmacia para rutear';
      statsEl.innerHTML = '';
      stepEl.className = 'route-step';
      stepEl.innerHTML = '<span class="arrow">·</span><span>Ajustá los filtros o la búsqueda para volver a tener candidatas.</span>';
      return;
    }

    const route = state.nav.route;
    card.classList.toggle('approx', Boolean(route && route.approx));
    badgeEl.textContent = route && route.approx ? 'Línea recta'
      : state.nav.pinnedId != null ? 'Destino fijado'
      : 'Más cercana';

    targetEl.innerHTML =
      `${escapeHtml(target.name)}<small>${escapeHtml(target.address)} · ${escapeHtml(target.zone)}</small>`;

    if (arrived) {
      statsEl.innerHTML = '<span class="dist">Llegaste</span>';
      stepEl.className = 'route-step';
      stepEl.innerHTML = '<span class="arrow">✓</span><span>Estás en la puerta de la farmacia.</span>';
      return;
    }

    const remaining = route && proj
      ? Math.max(0, route.distance - proj.along)
      : target.distance;
    const eta = route && proj
      ? (route.duration * (route.distance ? remaining / route.distance : 1))
      : (remaining != null ? remaining / NAV.WALK_MPS : null);

    statsEl.innerHTML = remaining == null ? '' : `
      <span class="dist">${formatDistance(remaining)}</span>
      <span class="eta">${eta != null ? formatEta(eta) : ''}</span>`;

    if (loading || !route || !proj) {
      stepEl.className = 'route-step loading';
      stepEl.innerHTML = '<span class="arrow">⟳</span><span>Calculando la ruta…</span>';
      return;
    }

    const step = nextStep(route, proj.along);
    stepEl.className = 'route-step';
    stepEl.innerHTML = step
      ? `<span class="arrow">↱</span><span>En <b>${formatDistance(step.in)}</b>, ${escapeHtml(step.text.charAt(0).toLowerCase() + step.text.slice(1))}</span>`
      : '<span class="arrow">↑</span><span>Seguí derecho hasta la farmacia.</span>';
  }

  function hideCard() {
    card.hidden = true;
    mapWrap.classList.remove('navigating');
  }

  // ---- API ----
  function start() {
    // Sin permiso todavía: lo pedimos y Geo nos vuelve a llamar al tenerlo.
    if (!state.userLocation) { Geo.enable(); return; }
    state.nav.active = true;
    state.nav.dismissed = false;
    state.nav.arrived = false;
    fitOnNextRoute = true;
    btnToggle.setAttribute('aria-pressed', 'true');
    sync({ force: true });
    ListView.render();
  }

  function stop({ dismissed = false } = {}) {
    const wasActive = state.nav.active;
    Object.assign(state.nav, {
      active: false, route: null, targetId: null,
      pinnedId: null, arrived: false, loading: false, dismissed,
    });
    clearTimeout(cooldownTimer);
    dirty = false;
    routeFrom = null;
    btnToggle.setAttribute('aria-pressed', 'false');
    MapView.clearRoute();
    MapView.setTarget(null);
    hideCard();
    if (wasActive) ListView.render();
  }

  function routeTo(id) {
    const f = state.pharmacies.find(p => p.id === id);
    if (!f) return;
    if (!hasValidCoords(f)) {
      Toast.show('Esta farmacia no se puede ubicar en el mapa', { isError: true });
      return;
    }
    state.nav.pinnedId = id;
    if (!state.userLocation) Toast.show('Necesito tu ubicación para trazar la ruta');
    start();
  }

  // Autoarranque al conseguir ubicación, salvo que la hayas cerrado a mano.
  function autoStart() {
    if (state.nav.dismissed || state.nav.active) return;
    start();
  }

  const onPositionChange = () => sync();
  // Cambió la lista o los filtros: alcanza con reevaluar el destino. Si sigue
  // siendo el mismo, la ruta vigente no hace falta recalcularla.
  const onDataChange = () => sync();

  function init() {
    btnToggle.addEventListener('click', () => {
      if (state.nav.active) {
        stop({ dismissed: true });
        Toast.show('Navegación terminada');
      } else {
        state.nav.pinnedId = null;
        start();
      }
    });

    btnClose.addEventListener('click', () => stop({ dismissed: true }));

    btnCenter.addEventListener('click', () => {
      if (state.nav.route) MapView.fitRoute(state.nav.route.coords);
      else MapView.flyToUser();
    });

    btnNearest.addEventListener('click', () => {
      state.nav.pinnedId = null;
      fitOnNextRoute = true;
      sync({ force: true });
      Toast.show('Siguiendo a la farmacia más cercana');
    });

    // Botones "Ruta" de las cards y de los popups del mapa
    document.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-route-to]');
      if (!btn) return;
      e.preventDefault();
      routeTo(btn.dataset.routeTo);
    });

    // El alto real de la tarjeta corre los controles de zoom en mobile
    if (window.ResizeObserver) {
      new ResizeObserver(() => {
        document.documentElement.style.setProperty('--route-card-h', `${card.offsetHeight}px`);
      }).observe(card);
    }
  }

  return { init, start, stop, routeTo, autoStart, onPositionChange, onDataChange };
})();

// --- Selection (top-level: usado por MapView y ListView) ---
function selectPharmacy(id, opts = {}) {
  const f = state.pharmacies.find(p => p.id === id);
  if (!f) return;
  state.activeId = id;
  MapView.highlight(id);

  if (opts.fromList) {
    if (hasValidCoords(f)) {
      MapView.flyTo(f);
      if (isMobile()) BottomSheet.setState('hidden');
    } else {
      Toast.show('Esta farmacia no se puede mostrar en el mapa', { isError: true });
    }
  }

  ListView.render();

  if (opts.fromMarker) {
    if (isMobile() && BottomSheet.currentState() === 'hidden') {
      BottomSheet.setState('peek');
    }
    ListView.scrollToActive();
  }
}

// --- Filters ---
function setupFilters() {
  $('#zones').addEventListener('click', (e) => {
    const btn = e.target.closest('.zone-chip');
    if (!btn) return;
    document.querySelectorAll('.zone-chip').forEach(c => c.classList.remove('active'));
    btn.classList.add('active');
    state.filter = btn.dataset.zone;

    const visibleList = ListView.filtered();
    MapView.filterVisible(new Set(visibleList.map(f => f.id)));
    ListView.render();
    Nav.onDataChange();   // cambió el conjunto de candidatas a "más cercana"
  });

  let searchTimer;
  $('#search').addEventListener('input', (e) => {
    state.search = e.target.value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { ListView.render(); Nav.onDataChange(); }, 120);
  });
}

// --- Clock ---
function setupClock() {
  const el = $('#clock-time');
  function tick() {
    const now = new Date();
    const time = now.toLocaleTimeString('es-AR', {
      hour: '2-digit', minute: '2-digit', hour12: false,
      timeZone: 'America/Argentina/Buenos_Aires',
    });
    const date = now.toLocaleDateString('es-AR', {
      day: '2-digit', month: '2-digit', timeZone: 'America/Argentina/Buenos_Aires',
    });
    el.textContent = `${date} · ${time}`;
  }
  tick();
  setInterval(tick, 30_000);
}

// --- Misc UI wiring ---
function setupMiscUI() {
  $('#banner-close')?.addEventListener('click', (e) => e.target.parentElement.remove());
  $('#fab-list').addEventListener('click', () => BottomSheet.setState('expanded'));

  // Tap en el mapa colapsa el sheet si estaba expandido (UX tipo Google Maps)
  $('#map').addEventListener('click', () => {
    if (isMobile() && BottomSheet.currentState() === 'expanded') {
      BottomSheet.setState('peek');
    }
  }, true);

  window.addEventListener('resize', () => {
    MapView.invalidateSize();
    if (!isMobile()) $('#sidebar').dataset.state = 'expanded';
  });
}

// --- Data loading ---
async function loadData({ fresh = false } = {}) {
  const btn = $('#btn-refresh');
  btn.disabled = true;
  btn.classList.add('spinning');
  if (fresh) ListView.showLoading('Re-scrapeando colfarmalp.org.ar…');

  try {
    const r = await fetch(DATA_URL);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    if (data.error) throw new Error(data.error);

    state.pharmacies = withStableIds(data.pharmacies);
    Geo.recomputeForNewData();

    ListView.setMeta(data);
    MapView.rebuild(state.pharmacies, selectPharmacy);
    ListView.render();
    // Los datos cambiaron: puede haber otra farmacia más cerca, o la que
    // estábamos siguiendo puede haber salido de turno.
    Nav.onDataChange();

    if (fresh) Toast.show(`✓ ${data.count} farmacias actualizadas`);
  } catch (err) {
    ListView.showError(err.message, () => loadData({ fresh: true }));
  } finally {
    btn.disabled = false;
    btn.classList.remove('spinning');
  }
}

// --- Init ---
function init() {
  setupFilters();
  setupClock();
  setupMiscUI();
  Nav.init();
  ListView.bindActivation(selectPharmacy);

  $('#btn-refresh').addEventListener('click', () => loadData({ fresh: true }));

  if (isMobile()) {
    requestAnimationFrame(() => BottomSheet.setState('peek'));
  }

  loadData();

  setTimeout(() => {
    $('#loading').classList.add('done');
    MapView.invalidateSize();
  }, 400);
}

document.addEventListener('DOMContentLoaded', init);
