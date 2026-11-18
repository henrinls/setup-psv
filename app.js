'use strict';
const VERSION = '1.1.0';
const TILE_URL = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
const TILE_CACHE = 'psv-tiles-v1';
const DEFAULT_PARAMS = {
  heading: 0, turn: 'G', t1: 10, t2: 4, setupBack: 100, setupSide: 60, recBack: 30,
  vref: 5, legLen: 150, legTime: 10, legHeight: 300, rings: true, ticks: true, corridor: true
};
const COLORS = { gates: '#ffd400', axis: '#ffffff', setup: '#ff7a1a', rec: '#22d3ee', leg: '#e879f9', ring: '#ff7a1a' };

// ---------- Stockage ----------
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { toast('Enregistrement impossible sur cet appareil'); } }
};
let zones = store.get('psv.zones', []);
let current = store.get('psv.current', null); // {id|null, name, center, zoom, gates, params}
if (!current) current = newZone(null);

function newZone(center) {
  return {
    id: null, name: 'Nouvelle zone',
    center: center || { lat: 46.6, lng: 2.4 }, zoom: center ? 17 : 6,
    gates: null,
    params: Object.assign({}, DEFAULT_PARAMS, store.get('psv.lastParams', {}))
  };
}
function persist() {
  current.center = map.getCenter(); current.zoom = map.getZoom();
  store.set('psv.current', current);
  store.set('psv.lastParams', current.params);
  if (current.id) {
    const i = zones.findIndex(z => z.id === current.id);
    if (i >= 0) { zones[i] = JSON.parse(JSON.stringify(current)); store.set('psv.zones', zones); }
  }
}

// ---------- Carte ----------
const map = L.map('map', { zoomControl: false, maxZoom: 22, attributionControl: true, tap: true })
  .setView([current.center.lat, current.center.lng], current.zoom);
L.tileLayer(TILE_URL, {
  maxNativeZoom: 19, maxZoom: 22,
  attribution: 'Imagerie © Esri, Maxar, Earthstar Geographics'
}).addTo(map);
L.control.zoom({ position: 'bottomright' }).addTo(map);
L.control.scale({ imperial: false, position: 'bottomleft' }).addTo(map);
map.on('moveend', () => { current.center = map.getCenter(); current.zoom = map.getZoom(); store.set('psv.current', current); });

const fig = L.layerGroup().addTo(map);
const grads = L.layerGroup().addTo(map);
let gatesMarker = null, axisHandle = null, placing = false, posMarker = null;

function dotIcon(color, size, label, cls) {
  return L.divIcon({
    className: 'dot ' + (cls || ''),
    html: `<span style="background:${color};width:${size}px;height:${size}px"></span>${label ? `<b style="color:${color}">${label}</b>` : ''}`,
    iconSize: [size, size], iconAnchor: [size / 2, size / 2]
  });
}

// ---------- Dessin ----------
let raf = 0;
function redraw() { cancelAnimationFrame(raf); raf = requestAnimationFrame(draw); }

function draw() {
  fig.clearLayers(); grads.clearLayers();
  const p = current.params, g = current.gates;
  updateLegend();
  if (!g) { setBanner('Touche la carte pour placer les portes.'); placing = true; syncPlaceBtn(); return; }
  if (!placing) setBanner(null);
  const c = Geo.compute(p);
  const ll = v => { const q = Geo.fromLocal(g, v); return [q.lat, q.lng]; };

  // Axe de poser : du recouvrement (ou arrière) jusqu'à devant les portes
  const backMost = Math.max(+p.recBack || 0, 20);
  const front = p.corridor ? 120 : 25;
  L.polyline([ll({ x: -c.f.x * backMost, y: -c.f.y * backMost }), ll({ x: c.f.x * front, y: c.f.y * front })],
    { color: COLORS.axis, weight: 2, dashArray: '8 6', opacity: .9, interactive: false }).addTo(fig);
  // Flèche du sens du poser
  const tip = { x: c.f.x * 30, y: c.f.y * 30 };
  const wing = (s) => ({ x: tip.x - c.f.x * 8 + s * c.r.x * 5, y: tip.y - c.f.y * 8 + s * c.r.y * 5 });
  L.polyline([ll(wing(-1)), ll(tip), ll(wing(1))], { color: COLORS.axis, weight: 3, interactive: false }).addTo(fig);

  // Branche d'approche
  if ((+p.legLen || 0) > 0) {
    L.polyline([ll(c.legStart), ll(c.setup)], { color: COLORS.leg, weight: 3, interactive: false }).addTo(fig);
    const mid = { x: (c.legStart.x + c.setup.x) / 2, y: (c.legStart.y + c.setup.y) / 2 };
    const dir = { x: c.setup.x - c.legStart.x, y: c.setup.y - c.legStart.y };
    const n = Math.hypot(dir.x, dir.y) || 1, u = { x: dir.x / n, y: dir.y / n }, w = { x: -u.y, y: u.x };
    const a = (s) => ({ x: mid.x - u.x * 8 + s * w.x * 5, y: mid.y - u.y * 8 + s * w.y * 5 });
    L.polyline([ll(a(-1)), ll(mid), ll(a(1))], { color: COLORS.leg, weight: 3, interactive: false }).addTo(fig);
    const info = [];
    if (+p.legHeight) info.push(`${p.legHeight} m`);
    if (+p.legTime) info.push(`${p.legTime} s`);
    L.marker(ll(c.legStart), { icon: dotIcon(COLORS.leg, 10, `Début branche${info.length ? ' · ' + info.join(' · ') : ''}<br><small>cap ${Math.round(c.legHeading)}°</small>`), interactive: false }).addTo(fig);
  }

  // Lien setup → recouvrement (repère visuel)
  L.polyline([ll(c.setup), ll(c.rec)], { color: '#fff', weight: 1, opacity: .45, dashArray: '2 6', interactive: false }).addTo(fig);

  // Cercles de vent
  drawWindCircle(g, c.setup, c.rSetup, COLORS.setup, p.rings);
  drawWindCircle(g, c.rec, c.rRec, COLORS.rec, p.rings);

  L.marker(ll(c.setup), { icon: dotIcon(COLORS.setup, 14, 'Setup'), interactive: false }).addTo(fig);
  L.marker(ll(c.rec), { icon: dotIcon(COLORS.rec, 11, 'Recouvrement'), interactive: false }).addTo(fig);

  placeGateMarkers();
}

function drawWindCircle(g, centerLocal, radius, color, rings) {
  if (!(radius > 0)) return;
  const center = Geo.fromLocal(g, centerLocal);
  L.circle([center.lat, center.lng], { radius, color, weight: 2.5, fill: true, fillOpacity: .06, interactive: false }).addTo(fig);
  if (rings) {
    const v = +current.params.vref || 5;
    for (let k = 1; k < v; k++) {
      L.circle([center.lat, center.lng], { radius: radius * k / v, color, weight: 1, opacity: .55, fill: false, dashArray: '3 5', interactive: false }).addTo(fig);
    }
  }
  if (current.params.ticks === false) return; // version épurée : pas de graduation
  // Graduations
  const z = map.getZoom();
  const mpp = 40075016.686 * Math.cos(center.lat * Math.PI / 180) / Math.pow(2, z + 8);
  const rPx = radius / mpp;
  const st = Geo.tickSteps(rPx);
  // repère Nord toujours présent
  const pt = (deg, d) => { const a = deg * Math.PI / 180; const q = Geo.fromLocal(center, { x: d * Math.sin(a), y: d * Math.cos(a) }); return [q.lat, q.lng]; };
  if (!st) {
    L.polyline([pt(0, radius), pt(0, radius - 8 * mpp)], { color, weight: 2, interactive: false }).addTo(grads);
    return;
  }
  const segs = [];
  const step = st.minor || st.label;
  for (let deg = 0; deg < 360; deg += step) {
    const major = deg % st.label === 0;
    const len = (major ? 11 : 6) * mpp;
    segs.push([pt(deg, radius), pt(deg, radius - len)]);
    if (major) {
      const card = { 0: ' N', 90: ' E', 180: ' S', 270: ' O' }[deg] || '';
      L.marker(pt(deg, radius + 13 * mpp), {
        interactive: false,
        icon: L.divIcon({ className: 'glabel', html: `<span style="color:${color}">${deg}°${card}</span>`, iconSize: [0, 0] })
      }).addTo(grads);
    }
  }
  L.polyline(segs, { color, weight: 1.5, interactive: false }).addTo(grads);
}

function placeGateMarkers() {
  const g = current.gates, p = current.params;
  const c = Geo.basis(p.heading);
  const hl = Geo.fromLocal(g, { x: c.f.x * 60, y: c.f.y * 60 });
  if (!gatesMarker) {
    gatesMarker = L.marker([g.lat, g.lng], { draggable: true, icon: dotIcon(COLORS.gates, 18, 'Portes', 'big'), zIndexOffset: 1000 }).addTo(map);
    gatesMarker.on('drag', e => { current.gates = { lat: e.latlng.lat, lng: e.latlng.lng }; drawLight(); });
    gatesMarker.on('dragend', () => { persist(); redraw(); });
    axisHandle = L.marker([hl.lat, hl.lng], { draggable: true, icon: dotIcon('#fff', 22, '', 'handle'), zIndexOffset: 1000 }).addTo(map);
    axisHandle.on('drag', e => {
      const v = Geo.toLocal(current.gates, e.latlng);
      current.params.heading = Math.round(Geo.bearingOf(v));
      fillInputs(['heading']); drawLight();
    });
    axisHandle.on('dragend', () => { persist(); redraw(); });
  } else {
    if (!isDragging(gatesMarker)) gatesMarker.setLatLng([g.lat, g.lng]);
    if (!isDragging(axisHandle)) axisHandle.setLatLng([hl.lat, hl.lng]);
  }
}
const isDragging = m => !!(m.dragging && m.dragging._draggable && m.dragging._draggable._moving);
let lightT = 0;
function drawLight() { const n = performance.now(); if (n - lightT > 60) { lightT = n; draw(); } }

function fitFigure() {
  if (!current.gates) return;
  const c = Geo.compute(current.params), g = current.gates;
  const pts = [c.gates, c.setup, c.rec, c.legStart];
  const r = c.rSetup || 0;
  pts.push({ x: c.setup.x + r, y: c.setup.y + r }, { x: c.setup.x - r, y: c.setup.y - r });
  const b = L.latLngBounds(pts.map(v => { const q = Geo.fromLocal(g, v); return [q.lat, q.lng]; }));
  map.fitBounds(b, { paddingTopLeft: [40, 80], paddingBottomRight: [150, 180], maxZoom: 19 });
}
function updateLegend() {
  const p = current.params, c = Geo.compute(p), t = (+p.t1 || 0) + (+p.t2 || 0);
  const r0 = n => Math.round(n);
  document.getElementById('legend').innerHTML =
    `<div><i style="background:${COLORS.setup}"></i>Cercle setup ${r0(c.rSetup)} m <small>(${p.vref} m/s × ${t} s)</small></div>` +
    `<div><i style="background:${COLORS.rec}"></i>Cercle recouvrement ${r0(c.rRec)} m <small>(${p.vref} m/s × ${p.t2} s)</small></div>` +
    `<div><i style="background:#fff"></i>Axe ${r0(p.heading)}° · virage ${p.turn === 'G' ? 'gauche' : 'droite'}</div>` +
    `<div class="mut">Déport face au vent : 1 m/s = ${r0(t)} m (setup) · ${r0(+p.t2 || 0)} m (recouvr.)</div>`;
}

// ---------- Interface ----------
const $ = id => document.getElementById(id);
function setBanner(t) { const b = $('banner'); if (!t) b.classList.add('hidden'); else { b.textContent = t; b.classList.remove('hidden'); } }
let toastT;
function toast(t) { const el = $('toast'); el.textContent = t; el.classList.remove('hidden'); clearTimeout(toastT); toastT = setTimeout(() => el.classList.add('hidden'), 2600); }

const numFields = ['heading', 't1', 't2', 'setupBack', 'setupSide', 'recBack', 'vref', 'legLen', 'legTime', 'legHeight'];
function fillInputs(only) {
  const p = current.params;
  (only || numFields).forEach(k => { const el = $('p_' + k); if (el && document.activeElement !== el) el.value = p[k]; });
  if (!only) {
    $('p_rings').checked = !!p.rings; $('p_ticks').checked = p.ticks !== false; $('p_corridor').checked = !!p.corridor;
    document.querySelectorAll('#turnSeg button').forEach(b => b.classList.toggle('on', b.dataset.turn === p.turn));
    $('zoneName').textContent = current.name + (current.id ? '' : ' (non enregistrée)');
  }
}
numFields.forEach(k => {
  $('p_' + k).addEventListener('input', e => {
    const v = parseFloat(String(e.target.value).replace(',', '.'));
    if (isNaN(v)) return;
    current.params[k] = k === 'heading' ? ((v % 360) + 360) % 360 : v;
    persist(); redraw();
  });
  $('p_' + k).addEventListener('blur', () => fillInputs([k]));
});
document.querySelectorAll('[data-step]').forEach(b => b.addEventListener('click', () => {
  const p = current.params; p.heading = ((Math.round(+p.heading) + +b.dataset.d) % 360 + 360) % 360;
  fillInputs(['heading']); persist(); redraw();
}));
document.querySelectorAll('#turnSeg button').forEach(b => b.addEventListener('click', () => {
  current.params.turn = b.dataset.turn; fillInputs(); persist(); redraw();
}));
$('p_rings').addEventListener('change', e => { current.params.rings = e.target.checked; persist(); redraw(); });
$('p_ticks').addEventListener('change', e => { current.params.ticks = e.target.checked; persist(); redraw(); });
$('p_corridor').addEventListener('change', e => { current.params.corridor = e.target.checked; persist(); redraw(); });

function syncPlaceBtn() { $('btnPlaceGates').classList.toggle('on', placing); }
$('btnPlaceGates').addEventListener('click', () => {
  placing = !placing; syncPlaceBtn();
  if (placing) { setBanner('Touche la carte à l\'endroit des portes.'); closeSheet(); } else setBanner(null);
});
map.on('click', e => {
  if (!placing) return;
  current.gates = { lat: e.latlng.lat, lng: e.latlng.lng };
  placing = false; syncPlaceBtn(); setBanner(null);
  persist(); redraw();
  toast('Portes placées. Oriente l\'axe avec la poignée blanche ou dans ⚙.');
});
map.on('zoomend', redraw);

// Feuille du bas
function openSheet(tab) {
  $('sheet').classList.remove('hidden');
  document.querySelectorAll('.tabs [data-tab]').forEach(b => b.classList.toggle('on', b.dataset.tab === tab));
  ['reglages', 'zones'].forEach(t => $('tab-' + t).classList.toggle('hidden', t !== tab));
  if (tab === 'zones') renderZones();
}
function closeSheet() { $('sheet').classList.add('hidden'); }
$('btnSettings').addEventListener('click', () => $('sheet').classList.contains('hidden') ? openSheet('reglages') : closeSheet());
$('btnZones').addEventListener('click', () => openSheet('zones'));
$('btnClose').addEventListener('click', closeSheet);
document.querySelectorAll('.tabs [data-tab]').forEach(b => b.addEventListener('click', () => openSheet(b.dataset.tab)));

// Dialogue maison (prompt est bloqué en mode appli)
function ask(text, def) {
  return new Promise(res => {
    $('dlgText').textContent = text; $('dlgInput').value = def || ''; $('dialog').classList.remove('hidden');
    $('dlgInput').classList.toggle('hidden', def === undefined);
    const done = v => { $('dialog').classList.add('hidden'); $('dlgOk').onclick = $('dlgCancel').onclick = null; res(v); };
    $('dlgOk').onclick = () => done(def === undefined ? true : $('dlgInput').value.trim());
    $('dlgCancel').onclick = () => done(null);
    if (def !== undefined) setTimeout(() => $('dlgInput').focus(), 50);
  });
}

// ---------- Zones ----------
function renderZones() {
  const ul = $('zoneList'); ul.innerHTML = '';
  if (!zones.length) ul.innerHTML = '<li class="mut">Aucune zone enregistrée.</li>';
  zones.forEach(z => {
    const li = document.createElement('li');
    li.className = z.id === current.id ? 'cur' : '';
    li.innerHTML = `<span class="zn">${esc(z.name)}${z.offline ? ' <small>· hors-ligne</small>' : ''}</span>`;
    const open = document.createElement('button'); open.textContent = 'Ouvrir'; open.onclick = () => loadZone(z.id);
    const ren = document.createElement('button'); ren.textContent = '✎'; ren.onclick = async () => {
      const n = await ask('Nouveau nom :', z.name); if (!n) return;
      z.name = n; if (current.id === z.id) current.name = n; store.set('psv.zones', zones); persist(); fillInputs(); renderZones();
    };
    const del = document.createElement('button'); del.textContent = '🗑'; del.onclick = async () => {
      if (!(await ask(`Supprimer « ${z.name} » ?`))) return;
      zones = zones.filter(x => x.id !== z.id); store.set('psv.zones', zones);
      if (current.id === z.id) { current.id = null; persist(); fillInputs(); }
      renderZones();
    };
    li.append(open, ren, del); ul.append(li);
  });
  $('offlineStatus').textContent = current.offline ? `Photo enregistrée hors-ligne le ${current.offline}.` : '';
}
function loadZone(id) {
  const z = zones.find(x => x.id === id); if (!z) return;
  current = JSON.parse(JSON.stringify(z));
  current.params = Object.assign({}, DEFAULT_PARAMS, current.params);
  resetGateMarkers();
  map.setView([current.center.lat, current.center.lng], Math.max(current.zoom || 17, 15));
  if (current.gates) map.setView([current.gates.lat, current.gates.lng], Math.max(current.zoom || 17, 16));
  placing = false; fillInputs(); fitFigure(); persist(); redraw(); closeSheet();
}
function resetGateMarkers() {
  if (gatesMarker) { map.removeLayer(gatesMarker); map.removeLayer(axisHandle); gatesMarker = axisHandle = null; }
}
$('btnSaveZone').addEventListener('click', async () => {
  const n = await ask('Nom de la zone (ex. Bouloc – zone swoop) :', current.id ? current.name : ''); if (!n) return;
  current.name = n;
  if (!current.id) { current.id = 'z' + Date.now(); zones.push(JSON.parse(JSON.stringify(current))); }
  store.set('psv.zones', zones); persist(); fillInputs(); renderZones(); toast('Zone enregistrée');
});
$('btnNewZone').addEventListener('click', async () => {
  if (!(await ask('Créer une nouvelle zone au centre de la carte ? (les réglages de virage sont repris)'))) return;
  const params = Object.assign({}, current.params);
  current = newZone(map.getCenter()); current.params = params; current.zoom = map.getZoom();
  resetGateMarkers(); placing = true; fillInputs(); persist(); redraw(); closeSheet();
});

// ---------- Recherche ----------
function parseCoords(s) {
  const d = s.replace(/,/g, ' ').trim().split(/\s+/);
  if (d.length === 2 && d.every(x => /^-?\d+(\.\d+)?$/.test(x))) {
    const lat = +d[0], lng = +d[1]; if (Math.abs(lat) <= 90 && Math.abs(lng) <= 180) return { lat, lng };
  }
  // DMS : 43°36'12"N 1°20'5"E
  const m = s.match(/(\d+)[°\s]+(\d+)['’\s]+([\d.]+)?["”\s]*([NS])[\s,]+(\d+)[°\s]+(\d+)['’\s]+([\d.]+)?["”\s]*([EWO])/i);
  if (m) {
    const lat = (+m[1] + m[2] / 60 + (+m[3] || 0) / 3600) * (/s/i.test(m[4]) ? -1 : 1);
    const lng = (+m[5] + m[6] / 60 + (+m[7] || 0) / 3600) * (/[wo]/i.test(m[8]) ? -1 : 1);
    return { lat, lng };
  }
  return null;
}
async function doSearch() {
  const q = $('searchInput').value.trim(); if (!q) return;
  const ul = $('searchResults'); ul.innerHTML = '';
  const c = parseCoords(q);
  if (c) { map.setView([c.lat, c.lng], 17); closeSheet(); return; }
  ul.innerHTML = '<li class="mut">Recherche…</li>';
  try {
    const r = await fetch('https://nominatim.openstreetmap.org/search?format=json&limit=8&accept-language=fr&q=' + encodeURIComponent(q));
    const js = await r.json(); ul.innerHTML = '';
    if (!js.length) ul.innerHTML = '<li class="mut">Rien trouvé.</li>';
    js.forEach(x => {
      const li = document.createElement('li'); const b = document.createElement('button');
      b.className = 'res'; b.textContent = x.display_name;
      b.onclick = () => { map.setView([+x.lat, +x.lon], 16); closeSheet(); };
      li.append(b); ul.append(li);
    });
  } catch (e) { ul.innerHTML = '<li class="mut">Recherche impossible (pas de réseau ?). Tu peux taper des coordonnées.</li>'; }
}
$('btnSearch').addEventListener('click', doSearch);
$('searchInput').addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });

// ---------- Position ----------
function locate(center) {
  if (!navigator.geolocation) { toast('Géolocalisation indisponible'); return; }
  navigator.geolocation.getCurrentPosition(pos => {
    const ll = [pos.coords.latitude, pos.coords.longitude];
    if (posMarker) posMarker.setLatLng(ll);
    else posMarker = L.circleMarker(ll, { radius: 7, color: '#fff', weight: 2, fillColor: '#2f80ff', fillOpacity: 1 }).addTo(map);
    if (center) map.setView(ll, Math.max(map.getZoom(), 17));
  }, () => toast('Position refusée ou indisponible'), { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 });
}
$('btnLocate').addEventListener('click', () => locate(true));
$('btnFit').addEventListener('click', () => { if (current.gates) fitFigure(); else toast('Place d\'abord les portes'); });

// ---------- Hors-ligne ----------
function tilesAround(center, radiusM, zmin, zmax) {
  const list = [];
  for (let z = zmin; z <= zmax; z++) {
    const n = Math.pow(2, z);
    const xt = lng => Math.floor((lng + 180) / 360 * n);
    const yt = lat => { const r = lat * Math.PI / 180; return Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * n); };
    const nw = Geo.fromLocal(center, { x: -radiusM, y: radiusM }), se = Geo.fromLocal(center, { x: radiusM, y: -radiusM });
    for (let x = xt(nw.lng); x <= xt(se.lng); x++) for (let y = yt(nw.lat); y <= yt(se.lat); y++)
      list.push(TILE_URL.replace('{z}', z).replace('{x}', x).replace('{y}', y));
  }
  return list;
}
$('btnOffline').addEventListener('click', async () => {
  if (!('caches' in window)) { toast('Hors-ligne non pris en charge ici'); return; }
  const center = current.gates || map.getCenter();
  const urls = tilesAround(center, 700, 12, 19).concat(tilesAround(center, 2500, 12, 16));
  const uniq = [...new Set(urls)];
  if (!(await ask(`Télécharger ${uniq.length} images (environ ${Math.round(uniq.length * 25 / 1024)} Mo) autour ${current.gates ? 'des portes' : 'du centre de la carte'} ?`))) return;
  const cache = await caches.open(TILE_CACHE);
  let done = 0, fail = 0; const st = $('offlineStatus');
  const worker = async () => {
    while (uniq.length) {
      const u = uniq.shift();
      try {
        if (!(await cache.match(u))) {
          let r;
          try { r = await fetch(u, { mode: 'cors' }); } catch (e) { r = await fetch(u, { mode: 'no-cors' }); }
          if (r.ok || r.type === 'opaque') await cache.put(u, r); else fail++;
        }
      } catch (e) { fail++; }
      done++; if (done % 10 === 0) st.textContent = `Téléchargement… ${done}`;
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  current.offline = new Date().toLocaleDateString('fr-FR'); persist();
  st.textContent = fail ? `Terminé avec ${fail} échecs (relance pour compléter).` : `Zone disponible hors-ligne (${done} images).`;
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
});

// ---------- Sauvegarde ----------
$('btnExport').addEventListener('click', async () => {
  const data = JSON.stringify({ v: 1, zones, current, lastParams: current.params });
  try { await navigator.clipboard.writeText(data); toast('Données copiées : colle-les dans une note pour les garder'); }
  catch (e) { $('ioText').value = data; $('ioText').classList.remove('hidden'); toast('Copie auto impossible : sélectionne le texte'); }
});
$('btnImport').addEventListener('click', () => { $('ioText').value = ''; $('ioText').classList.remove('hidden'); $('btnImportGo').classList.remove('hidden'); });
$('btnImportGo').addEventListener('click', async () => {
  try {
    const d = JSON.parse($('ioText').value);
    if (!Array.isArray(d.zones)) throw 0;
    if (!(await ask(`Remplacer tes zones par les ${d.zones.length} zones importées ?`))) return;
    zones = d.zones; store.set('psv.zones', zones);
    if (d.current) { current = d.current; resetGateMarkers(); }
    fillInputs(); persist(); redraw(); renderZones(); toast('Import réussi');
    $('ioText').classList.add('hidden'); $('btnImportGo').classList.add('hidden');
  } catch (e) { toast('Données illisibles'); }
});

function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

// ---------- Démarrage ----------
$('ver').textContent = VERSION;
fillInputs();
if (current.gates) fitFigure();
redraw();
if (!current.gates && !current.id && current.zoom < 10) locate(true); else locate(false);
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
