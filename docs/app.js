/* ============================================================
   FarmaGuardia LP — frontend
   ============================================================
   Responsabilidades:
     - Cargar /api/farmacias y renderizar lista + mapa (Leaflet)
     - Filtros por zona + búsqueda libre
     - Sincronización mapa ↔ lista (selección bidireccional)
     - Geolocalización opcional (off por defecto)
     - En mobile: bottom-sheet arrastrable con 3 estados
   ============================================================ */

// -------------- Config --------------
const ZONE_COLORS = {
  'La Plata':   '#0f4c3a',
  'Norte':      '#5b8fb5',
  'Los Hornos': '#e94f3a',
};
const DEFAULT_COLOR = '#0f4c3a';
const MOBILE_BREAKPOINT = 820;
const DEFAULT_CENTER = [-34.92, -57.96]; // La Plata
const DEFAULT_ZOOM = 13;

// -------------- DOM helpers --------------
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

function isMobile() {
  return window.innerWidth <= MOBILE_BREAKPOINT;
}

/**
 * Distancia entre dos coordenadas (Haversine), en metros.
 */
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

/**
 * Valida coordenadas de una farmacia. Si el scraper sacó la lat/lng de una
 * URL de Google Maps mal formada (ej.: `destination=0,0` cuando el sitio
 * no tenía link real), la farmacia aparecería en el medio del océano y
 * arrastraría el mapa entero. Filtramos esos casos:
 *   - no numéricos / NaN / null
 *   - exactamente 0 en lat o lng (placeholder típico de error de parseo)
 *   - fuera de rango terrestre (lat ∈ [-90,90], lng ∈ [-180,180])
 */
function hasValidCoords(f) {
  const lat = Number(f.lat);
  const lng = Number(f.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
  if (lat === 0 || lng === 0) return false;
  if (lat < -90 || lat > 90) return false;
  if (lng < -180 || lng > 180) return false;
  return true;
}

// -------------- State --------------
const state = {
  pharmacies: [],
  meta: {},
  filter: 'all',
  search: '',
  activeId: null,
  userLocation: null,      // { lat, lng, accuracy } | null
  locating: false,
};

// -------------- Toast --------------
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

// -------------- Map --------------
const MapView = (() => {
  const map = L.map('map', {
    center: DEFAULT_CENTER,
    zoom: DEFAULT_ZOOM,
    zoomControl: true,
    tap: true,
  });

  L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> · © <a href="https://carto.com/attributions">CARTO</a>',
    subdomains: 'abcd',
    maxZoom: 19,
  }).addTo(map);

  const markers = new Map();
  let userMarker = null;
  let userCircle = null;

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
      ? `<div style="margin-top:4px;font-family:Fraunces,serif;font-style:italic;font-size:12px;color:#0f4c3a">A ${formatDistance(f.distance)} de tu ubicación</div>` : '';
    return `
      <div>
        <div class="popup-name">${escapeHtml(f.name)}</div>
        <div class="popup-addr">${escapeHtml(f.address)}<br/><strong>${escapeHtml(f.zone)}</strong>${dist}</div>
        <div class="popup-actions">
          <a class="pharma-btn call" href="tel:${cleanPhone(f.phone)}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg>
            Llamar
          </a>
          <a class="pharma-btn" target="_blank" rel="noopener"
             href="https://www.google.com/maps/dir/?api=1&destination=${f.lat},${f.lng}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>
            Cómo llegar
          </a>
        </div>
      </div>`;
  }

  function rebuild(pharmacies, onSelect) {
    markers.forEach(m => map.removeLayer(m));
    markers.clear();

    pharmacies.forEach(f => {
      // Si la farmacia no tiene coordenadas válidas, no la dibujamos en el
      // mapa. Igual aparece en la lista con un aviso (ver ListView.cardHTML).
      if (!hasValidCoords(f)) return;

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
    });

    fitToVisibleMarkers();
  }

  function updatePopups(pharmaciesById) {
    // Cuando cambian las distancias (al obtener la ubicación), actualizamos
    // el HTML de cada popup para reflejar la distancia.
    markers.forEach((marker, id) => {
      const f = pharmaciesById.get(id);
      if (f) marker.setPopupContent(popupHTML(f));
    });
  }

  function filterVisible(visibleIds) {
    markers.forEach((marker, id) => {
      if (visibleIds.has(id)) {
        if (!map.hasLayer(marker)) marker.addTo(map);
      } else if (map.hasLayer(marker)) {
        map.removeLayer(marker);
      }
    });
    fitToVisibleMarkers();
  }

  function fitToVisibleMarkers() {
    const visibleMarkers = Array.from(markers.values()).filter(m => map.hasLayer(m));
    const group = L.featureGroup([...visibleMarkers, ...(userMarker ? [userMarker] : [])]);
    if (group.getLayers().length > 0) {
      try {
        map.flyToBounds(group.getBounds(), { padding: [60, 60], duration: 0.6, maxZoom: 15 });
      } catch (e) {
        map.setView(DEFAULT_CENTER, DEFAULT_ZOOM);
      }
    }
  }

  function highlight(activeId) {
    markers.forEach((marker, id) => {
      const el = marker.getElement();
      const pin = el && el.querySelector('.pin');
      if (pin) pin.classList.toggle('active', id === activeId);
    });
  }

  function flyTo(f) {
    if (!hasValidCoords(f)) return;
    map.flyTo([f.lat, f.lng], Math.max(map.getZoom(), 16), { duration: 0.6 });
    setTimeout(() => markers.get(f.id)?.openPopup(), 400);
  }

  function setUserLocation(location) {
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
      userCircle = L.circle([location.lat, location.lng], {
        radius: location.accuracy,
        color: '#3b82f6',
        fillColor: '#3b82f6',
        fillOpacity: 0.08,
        weight: 1,
      }).addTo(map);
    }
  }

  function flyToUser() {
    if (!userMarker) return;
    map.flyTo(userMarker.getLatLng(), Math.max(map.getZoom(), 15), { duration: 0.6 });
  }

  function invalidateSize() { map.invalidateSize(); }

  return {
    rebuild, updatePopups, filterVisible, highlight, flyTo,
    fitToVisibleMarkers, setUserLocation, flyToUser, invalidateSize
  };
})();

// -------------- List --------------
const ListView = (() => {
  const listEl  = $('#list');
  const countEl = $('#stat-count');
  const labelEl = $('#stat-filtered');
  const metaEl  = $('#source-meta');
  const fabCountEl = $('#fab-list-count');

  function filtered() {
    const q = state.search.trim().toLowerCase();
    let list = state.pharmacies.filter(f => {
      if (state.filter !== 'all' && f.zone !== state.filter) return false;
      if (q && !(f.name.toLowerCase().includes(q) || f.address.toLowerCase().includes(q))) return false;
      return true;
    });

    // Si tenemos ubicación del usuario, ordenamos por distancia.
    if (state.userLocation) {
      list.sort((a, b) => (a.distance ?? Infinity) - (b.distance ?? Infinity));
    }
    return list;
  }

  function cardHTML(f, idx) {
    const color = ZONE_COLORS[f.zone] || DEFAULT_COLOR;
    const invalidCoords = !hasValidCoords(f);

    const distHtml = f.distance != null
      ? `<span class="pharma-distance">${formatDistance(f.distance)}</span>`
      : `<div class="pharma-num">Nº ${String(idx + 1).padStart(2, '0')}</div>`;

    // Aviso simple para el usuario final. Sin tecnicismos: la dirección
    // está en la card, pero el mapa no la puede ubicar.
    const warnHtml = invalidCoords
      ? `<div class="pharma-warn">No se puede mostrar en el mapa porque la dirección no se pudo ubicar. Revisá la dirección o llamá antes de ir.</div>`
      : '';

    // El botón "Ir" abre Google Maps con la lat/lng — si son inválidas
    // mandaríamos al usuario al medio del océano, así que lo deshabilitamos.
    const goBtn = invalidCoords
      ? `<span class="pharma-btn disabled" aria-disabled="true" title="Ubicación no disponible">
           <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>
           Sin ubicación
         </span>`
      : `<a class="pharma-btn" target="_blank" rel="noopener"
            href="https://www.google.com/maps/dir/?api=1&destination=${f.lat},${f.lng}"
            onclick="event.stopPropagation()">
           <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>
           Ir
         </a>`;

    return `
      <article class="pharma ${invalidCoords ? 'no-coords' : ''} ${state.activeId === f.id ? 'active' : ''}" data-id="${f.id}">
        <div class="pharma-head">
          <div class="pharma-name">${escapeHtml(f.name)}</div>
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
            <a class="pharma-btn call" href="tel:${cleanPhone(f.phone)}" onclick="event.stopPropagation()">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg>
              ${escapeHtml(f.phone)}
            </a>
            ${goBtn}
          </div>
        </div>
      </article>`;
  }

  function render(onSelect) {
    const list = filtered();
    countEl.textContent = list.length;
    labelEl.textContent = state.filter === 'all' ? 'farmacias' : state.filter;
    fabCountEl.textContent = list.length;

    if (state.pharmacies.length === 0) return;

    if (list.length === 0) {
      listEl.innerHTML = '<div class="state-msg"><span class="big">∅</span>Sin resultados.<br/>Probá otros filtros o términos.</div>';
      return;
    }

    listEl.innerHTML = list.map(cardHTML).join('');
    listEl.querySelectorAll('.pharma').forEach(el => {
      el.addEventListener('click', () => {
        onSelect(Number(el.dataset.id), { fromList: true });
      });
    });
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

  return { render, setMeta, showError, showLoading, scrollToActive, filtered };
})();

// -------------- Bottom sheet (mobile) --------------
const BottomSheet = (() => {
  /**
   * En mobile el sidebar se comporta como un bottom sheet con 3 estados.
   * El usuario puede:
   *   - arrastrar el handle para cambiar de estado,
   *   - tocar una farmacia (la lleva a peek y abre el mapa),
   *   - tocar el FAB "Ver lista" (lo expande).
   */
  const sidebar = $('#sidebar');
  const handle = $('#sheet-handle');

  function setState(newState) {
    if (!['expanded', 'peek', 'hidden'].includes(newState)) return;
    sidebar.dataset.state = newState;
    // Cuando cambia el layout, avisar al mapa para recalcular tiles.
    setTimeout(() => MapView.invalidateSize(), 350);
  }

  function currentState() { return sidebar.dataset.state || 'expanded'; }

  // --- Gesture handling ---
  let startY = 0;
  let startTransform = 0;
  let dragging = false;
  let sheetHeight = 0;

  function onPointerDown(e) {
    if (!isMobile()) return;
    dragging = true;
    sidebar.classList.add('dragging');
    startY = e.touches ? e.touches[0].clientY : e.clientY;
    sheetHeight = sidebar.getBoundingClientRect().height;
    const t = new DOMMatrix(getComputedStyle(sidebar).transform);
    startTransform = t.m42; // componente translateY
    e.preventDefault();
  }

  function onPointerMove(e) {
    if (!dragging) return;
    const y = e.touches ? e.touches[0].clientY : e.clientY;
    const delta = y - startY;
    let newTransform = Math.max(0, startTransform + delta);
    sidebar.style.transform = `translateY(${newTransform}px)`;
  }

  function onPointerUp() {
    if (!dragging) return;
    dragging = false;
    sidebar.classList.remove('dragging');
    sidebar.style.transform = '';   // deja que CSS vuelva a manejar el estado

    // Snap al estado más cercano, basándose en dónde quedó el top del sheet.
    const rect = sidebar.getBoundingClientRect();
    const viewportH = window.innerHeight;
    const topFromViewport = rect.top;

    // Si el sheet está en el tercio superior: expanded
    // Si está en el medio: peek
    // Si está muy abajo: hidden
    if (topFromViewport < viewportH * 0.35) {
      setState('expanded');
    } else if (topFromViewport < viewportH * 0.78) {
      setState('peek');
    } else {
      setState('hidden');
    }
  }

  handle.addEventListener('touchstart', onPointerDown, { passive: false });
  handle.addEventListener('touchmove', onPointerMove, { passive: false });
  handle.addEventListener('touchend', onPointerUp);
  handle.addEventListener('touchcancel', onPointerUp);

  // Click en el handle: ciclar entre estados
  handle.addEventListener('click', () => {
    if (!isMobile()) return;
    const next = { expanded: 'peek', peek: 'hidden', hidden: 'expanded' };
    setState(next[currentState()] || 'peek');
  });

  return { setState, currentState };
})();

// -------------- Geolocation --------------
const Geo = (() => {
  const btn = $('#btn-locate');
  let watchId = null;

  function setActive(active) {
    btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    btn.title = active ? 'Ocultar mi ubicación' : 'Mostrar mi ubicación';
  }

  function setLoading(loading) {
    btn.classList.toggle('locating', loading);
    btn.disabled = loading;
  }

  function computeDistances() {
    if (!state.userLocation) {
      state.pharmacies.forEach(f => { f.distance = null; });
      return;
    }
    const { lat, lng } = state.userLocation;
    state.pharmacies.forEach(f => {
      // Farmacias sin coords válidas no tienen distancia calculable
      f.distance = hasValidCoords(f) ? haversine(lat, lng, f.lat, f.lng) : null;
    });
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
        state.userLocation = {
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy: pos.coords.accuracy,
        };
        state.locating = true;
        setLoading(false);
        setActive(true);

        MapView.setUserLocation(state.userLocation);
        computeDistances();

        // Actualizar popups con distancias
        const byId = new Map(state.pharmacies.map(p => [p.id, p]));
        MapView.updatePopups(byId);

        ListView.render(selectPharmacy);

        // Ajustar vista para incluir al usuario y las farmacias visibles
        MapView.fitToVisibleMarkers();

        Toast.show('Ubicación activa · lista ordenada por cercanía');

        // Seguir actualizando la posición
        watchId = navigator.geolocation.watchPosition(
          (p) => {
            state.userLocation = {
              lat: p.coords.latitude,
              lng: p.coords.longitude,
              accuracy: p.coords.accuracy,
            };
            MapView.setUserLocation(state.userLocation);
            computeDistances();
            const byId2 = new Map(state.pharmacies.map(pp => [pp.id, pp]));
            MapView.updatePopups(byId2);
            ListView.render(selectPharmacy);
          },
          () => { /* ignoramos errores de watch */ },
          { enableHighAccuracy: true, maximumAge: 60_000, timeout: 30_000 }
        );
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
    state.locating = false;
    setActive(false);
    MapView.setUserLocation(null);
    computeDistances();
    const byId = new Map(state.pharmacies.map(p => [p.id, p]));
    MapView.updatePopups(byId);
    ListView.render(selectPharmacy);
    Toast.show('Ubicación desactivada');
  }

  function toggle() {
    if (state.userLocation) {
      disable();
    } else {
      enable();
    }
  }

  function recomputeForNewData() {
    // Cuando se refrescan los datos, recomputamos distancias si ya
    // teníamos la ubicación del usuario.
    if (state.userLocation) {
      computeDistances();
    }
  }

  btn.addEventListener('click', () => {
    // Doble uso: si ya está activo y el usuario toca, centramos el mapa en él
    // (comportamiento típico de apps tipo Google Maps)
    if (state.userLocation) {
      MapView.flyToUser();
    } else {
      toggle();
    }
  });

  // Long-press para desactivar
  let pressTimer;
  btn.addEventListener('pointerdown', () => {
    if (!state.userLocation) return;
    pressTimer = setTimeout(() => disable(), 700);
  });
  btn.addEventListener('pointerup', () => clearTimeout(pressTimer));
  btn.addEventListener('pointerleave', () => clearTimeout(pressTimer));

  return { enable, disable, toggle, recomputeForNewData };
})();

// -------------- Selection --------------
function selectPharmacy(id, opts = {}) {
  const f = state.pharmacies.find(p => p.id === id);
  if (!f) return;
  state.activeId = id;

  MapView.highlight(id);

  const canShowOnMap = hasValidCoords(f);

  if (opts.fromList) {
    if (canShowOnMap) {
      MapView.flyTo(f);
      if (isMobile()) {
        BottomSheet.setState('hidden');   // dejo ver el mapa
      }
    } else {
      // No tiene sentido volar el mapa a un punto inválido. Avisamos al
      // usuario y mantenemos la lista visible para que vea el detalle.
      Toast.show('Esta farmacia no se puede mostrar en el mapa', { isError: true });
    }
  }

  ListView.render(selectPharmacy);

  if (opts.fromMarker) {
    // Si vengo de un tap en el mapa en mobile, subo un poquito el sheet
    // para que vea la tarjeta pero sin tapar todo el mapa.
    if (isMobile() && BottomSheet.currentState() === 'hidden') {
      BottomSheet.setState('peek');
    }
    ListView.scrollToActive();
  }
}

// -------------- Filters --------------
function setupFilters() {
  $('#zones').addEventListener('click', (e) => {
    const btn = e.target.closest('.zone-chip');
    if (!btn) return;
    document.querySelectorAll('.zone-chip').forEach(c => c.classList.remove('active'));
    btn.classList.add('active');
    state.filter = btn.dataset.zone;

    const visible = new Set(ListView.filtered().map(f => f.id));
    MapView.filterVisible(visible);
    ListView.render(selectPharmacy);
  });

  let searchTimer;
  $('#search').addEventListener('input', (e) => {
    state.search = e.target.value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => ListView.render(selectPharmacy), 120);
  });
}

// -------------- Clock --------------
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
  setInterval(tick, 30000);
}

// -------------- Misc UI wiring --------------
function setupMiscUI() {
  $('#banner-close').addEventListener('click', (e) => e.target.parentElement.remove());
  $('#fab-list').addEventListener('click', () => BottomSheet.setState('expanded'));

  // En mobile, si el usuario scrollea arriba en la lista cuando ya está en
  // expanded, cuando vuelve a tocar el mapa queremos que colapse.
  // Escuchamos click en el mapa para colapsar si sheet está expanded:
  $('#map').addEventListener('click', () => {
    if (isMobile() && BottomSheet.currentState() === 'expanded') {
      BottomSheet.setState('peek');
    }
  }, true);

  // Recomputar layout al girar/resizear
  window.addEventListener('resize', () => {
    MapView.invalidateSize();
    if (!isMobile()) {
      // Al volver a desktop, reseteamos el estado del sheet
      $('#sidebar').dataset.state = 'expanded';
    }
  });
}

// -------------- Data loading --------------
async function loadData({ fresh = false } = {}) {
  const btn = $('#btn-refresh');
  btn.disabled = true;
  btn.classList.add('spinning');
  if (fresh) ListView.showLoading('Re-scrapeando colfarmalp.org.ar…');

  try {
	const url = 'data/farmacias.json';
    const r = await fetch(url);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    if (data.error) throw new Error(data.error);

    state.pharmacies = data.pharmacies.map((p, i) => ({ ...p, id: i, distance: null }));
    state.meta = data;

    // Si había ubicación activa, recomputar distancias.
    Geo.recomputeForNewData();

    ListView.setMeta(data);
    MapView.rebuild(state.pharmacies, selectPharmacy);
    ListView.render(selectPharmacy);

    if (fresh) Toast.show(`✓ ${data.count} farmacias actualizadas`);
  } catch (err) {
    ListView.showError(err.message, () => loadData({ fresh: true }));
  } finally {
    btn.disabled = false;
    btn.classList.remove('spinning');
  }
}

// -------------- Init --------------
function init() {
  setupFilters();
  setupClock();
  setupMiscUI();

  $('#btn-refresh').addEventListener('click', () => loadData({ fresh: true }));

  // En mobile arrancamos con el sheet en "peek" para que se vea el mapa
  if (isMobile()) {
    // Esperamos un tick para que el layout esté listo
    requestAnimationFrame(() => BottomSheet.setState('peek'));
  }

  loadData();

  setTimeout(() => {
    $('#loading').classList.add('done');
    MapView.invalidateSize();
  }, 400);
}

document.addEventListener('DOMContentLoaded', init);
