'use strict';
// Filet de sécurité : toute erreur s'affiche au lieu de laisser une carte vide
window.addEventListener('error', e => {
  const t = document.getElementById('toast');
  if (t) { t.textContent = 'Erreur : ' + (e.message || 'inconnue') + ' — ferme et rouvre l\'appli'; t.classList.remove('hidden'); }
});
const VERSION = '3.10.0';
const APP_ID = 'psv';
// Fonds de carte : Esri (monde entier) ou photos aériennes IGN (France, licence ouverte : hors-ligne et PDF autorisés)
const BASEMAPS = {
  esri: { url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', attr: 'Imagerie © Esri, Maxar, Earthstar Geographics', maxNative: 19 },
  ign: { url: 'https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=ORTHOIMAGERY.ORTHOPHOTOS&STYLE=normal&TILEMATRIXSET=PM&FORMAT=image/jpeg&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}', attr: 'Photos aériennes © IGN – Géoplateforme', maxNative: 19 }
};
const TILE_CACHE = 'psv-tiles-v2';
const DEFAULT_PARAMS = {
  t1: 10, t2: 4, setupBack: 100, setupSide: 60, recBack: 30,
  vref: 5, legLen: 150, legTime: 10, legSpeed: 15, legHeight: 300, setupHeight: null, rings: true, ticks: true, labels: true, rec: true
};
// Mêmes couleurs pour les deux configurations (demande d'Henri)
const CFG_COLORS = { setup: '#ff2020', rec: '#ffd400', leg: '#000000' };
const PALETTE = { A: CFG_COLORS, B: CFG_COLORS };
const GATE_COLOR = '#ff8c00', AXIS_COLOR = '#ffffff';
const isDark = c => c === '#000000';

// ---------- Stockage ----------
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { toast('Enregistrement impossible sur cet appareil'); } }
};
const clone = o => JSON.parse(JSON.stringify(o));

// Passage du format v1 (une porte + cap) au format v2 (portes A et B)
function upgrade(z) {
  if (!z) return z;
  z.params = Object.assign({}, DEFAULT_PARAMS, z.params || {});
  if (z.gates && !z.gateA) {
    const h = +z.params.heading || 0, rad = h * Math.PI / 180;
    z.gateA = z.gates;
    z.gateB = Geo.fromLocal(z.gates, { x: 100 * Math.sin(rad), y: 100 * Math.cos(rad) });
    z.turnA = z.params.turn || 'G';
    z.turnB = z.params.turn || 'G';
  }
  delete z.gates; delete z.params.heading; delete z.params.turn; delete z.params.corridor;
  z.turnA = z.turnA || 'G'; z.turnB = z.turnB || 'G'; z.show = z.show || 'AB'; z.single = !!z.single;
  return z;
}
let zones = store.get('psv.zones', []).map(upgrade);
let current = upgrade(store.get('psv.current', null)) || newZone(null);
store.set('psv.zones', zones);

// ---------- Profil pilote : réglages communs à toutes les zones ----------
// Temps du virage, déports du setup et du point de snap, vent de référence : c'est la façon de tourner
// d'Henri, pas une propriété de la zone. Une modification se répercute sur toutes les zones enregistrées.
const PROFILE_KEYS = ['t1', 't2', 'setupBack', 'setupSide', 'recBack', 'vref', 'legLen', 'legTime', 'legSpeed', 'legHeight', 'setupHeight']; // + étape de base
let profile = store.get('psv.profile', null);
if (!profile) profile = {};
PROFILE_KEYS.forEach(k => { if (profile[k] === undefined) profile[k] = current.params[k] !== undefined ? current.params[k] : DEFAULT_PARAMS[k]; }); // complète un profil plus ancien
// Longueur de l'étape de base = durée × vitesse (la longueur n'est plus saisie)
function legLenOf(p) { return Math.round((+p.legTime || 0) * (+p.legSpeed || 0)); }
profile.legLen = legLenOf(profile); store.set('psv.profile', profile);
store.set('psv.profile', profile);
function applyProfile(z) { if (z && z.params) PROFILE_KEYS.forEach(k => { z.params[k] = profile[k]; }); }
applyProfile(current); zones.forEach(applyProfile); store.set('psv.zones', zones);
// Plus de bouton « Enregistrer » : une ancienne zone en cours, jamais enregistrée mais avec ses portes, rejoint la liste
if (!current.id && current.gateA && current.gateB) { current.id = 'z' + Date.now(); zones.push(clone(current)); store.set('psv.zones', zones); store.set('psv.current', current); }

function newZone(center) {
  return upgrade({
    id: null, name: 'Nouvelle zone',
    center: center || { lat: 46.6, lng: 2.4 }, zoom: center ? 17 : 6,
    gateA: null, gateB: null, turnA: 'G', turnB: 'G', show: 'AB',
    params: Object.assign({}, DEFAULT_PARAMS, store.get('psv.lastParams', {}))
  });
}
function persist() {
  current.center = map.getCenter(); current.zoom = map.getZoom(); current.updated = Date.now();
  store.set('psv.current', current);
  store.set('psv.lastParams', current.params);
  if (current.id) {
    const i = zones.findIndex(z => z.id === current.id);
    if (i >= 0) { zones[i] = clone(current); store.set('psv.zones', zones); }
  }
}

// Noms affichés : cap de l'axe de poser sur 3 chiffres + G/D (jamais A/B à l'écran)
const hdg = h => String(Math.round(h) % 360).padStart(3, '0') + '°';
function headingOf(key) { const h = axisHeading(); return key === 'A' ? h : (h + 180) % 360; }
// Nom d'un sens de poser : point cardinal le plus proche ; pile entre deux (45°, 135°…) → N ou S par convention
function cardOf(h) { h = ((h % 360) + 360) % 360; if (h >= 315 || h <= 45) return 'N'; if (h >= 135 && h <= 225) return 'S'; return h < 180 ? 'E' : 'O'; }
function cfgName(c) { return `${cardOf(c.heading)} ${c.turn}`; }
function cfgNameKey(key) { return hasGates() ? `${cardOf(headingOf(key))} ${current['turn' + key]}` : (key === 'A' ? 'porte 1' : 'porte 2'); }
const showLabels = () => false; // textes sur les éléments : jamais affichés (demande d'Henri)
const showRec = () => current.params.rec !== false; // point de snap + son cercle (le temps de recouvrement = du point de snap aux portes)

// ---------- Figure (calcul pur, réutilisé par la carte et le PDF) ----------
function hasGates() { return !!(current.gateA && current.gateB); }
function axisHeading() { return Geo.bearingOf(Geo.toLocal(current.gateA, current.gateB)); }
function corridorLength() { const v = Geo.toLocal(current.gateA, current.gateB); return Math.hypot(v.x, v.y); }

// Une configuration = une porte (origine), le cap du poser depuis cette porte, le sens du virage.
function configs() {
  if (!hasGates()) return [];
  const hA = axisHeading(), hB = (hA + 180) % 360, out = [];
  const sh = current.show || 'AB';
  if (current.single ? sh !== 'none' : (sh === 'AB' || sh === 'A')) out.push({ key: 'A', gate: current.gateA, heading: hA, turn: current.turnA });
  if (!current.single && (sh === 'AB' || sh === 'B')) out.push({ key: 'B', gate: current.gateB, heading: hB, turn: current.turnB });
  return out.map(c => {
    const g = Geo.compute(Object.assign({}, current.params, { heading: c.heading, turn: c.turn }));
    const ll = v => Geo.fromLocal(c.gate, v);
    return Object.assign(c, {
      geo: g, colors: PALETTE[c.key],
      setup: ll(g.setup), rec: ll(g.rec), legStart: ll(g.legStart),
      behind: ll({ x: -g.f.x * Math.max(+current.params.recBack || 0, 15), y: -g.f.y * Math.max(+current.params.recBack || 0, 15) })
    });
  });
}
// Toutes les positions à faire tenir dans un cadrage (en lat/lng)
function figurePoints() {
  const pts = [];
  if (current.gateA) pts.push(current.gateA);
  if (current.gateB) pts.push(current.gateB);
  configs().forEach(c => {
    pts.push(c.legStart); if (showRec()) pts.push(c.rec, c.behind);
    const r = c.geo.rSetup || 0;
    for (let k = 0; k < 16; k++) { const a = k * Math.PI / 8; pts.push(Geo.fromLocal(c.setup, { x: r * Math.sin(a), y: r * Math.cos(a) })); } // tour du cercle (marche aussi carte tournée)
    pts.push(c.setup);
  });
  return pts;
}

// ---------- Carte ----------
const map = L.map('map', { zoomControl: false, maxZoom: 22, zoomSnap: 0.25, attributionControl: true,
  rotate: true, touchRotate: true, bearing: current.bearing || 0, rotateControl: false, touchPitch: false, pitchDrag: false, shiftKeyRotate: true })
  .setView([current.center.lat, current.center.lng], current.zoom);
let basemap = (store.get('psv.basemap', 'esri') in BASEMAPS) ? store.get('psv.basemap', 'esri') : 'esri';
let baseLayer = null, tileFails = 0;
function setBasemap(k, msg) {
  basemap = BASEMAPS[k] ? k : 'esri'; store.set('psv.basemap', basemap);
  if (baseLayer) map.removeLayer(baseLayer);
  const B = BASEMAPS[basemap]; tileFails = 0;
  baseLayer = L.tileLayer(B.url, { maxNativeZoom: B.maxNative, maxZoom: 22, crossOrigin: 'anonymous', attribution: B.attr }).addTo(map);
  baseLayer.on('tileerror', () => { if (++tileFails === 12 && basemap === 'ign') toast('Photos IGN indisponibles ici (hors France ou pas de réseau) : repasse sur « Satellite »'); });
  $('bmEsri').classList.toggle('on', basemap === 'esri'); $('bmIgn').classList.toggle('on', basemap === 'ign');
  if (msg) toast(basemap === 'ign' ? 'Fond : photos aériennes IGN (France)' : 'Fond : satellite Esri (monde)');
}
setBasemap(basemap);
$('bmEsri').addEventListener('click', () => setBasemap('esri', true));
$('bmIgn').addEventListener('click', () => setBasemap('ign', true));
L.control.zoom({ position: 'bottomright' }).addTo(map);
L.control.scale({ imperial: false, position: 'bottomleft' }).addTo(map);
map.on('moveend', () => { current.center = map.getCenter(); current.zoom = map.getZoom(); store.set('psv.current', current); });
// Boussole : indique le nord quand la carte est tournée ; un appui remet le nord en haut
function syncCompass() {
  const b = map.getBearing ? map.getBearing() : 0;
  $('compassNeedle').style.transform = `rotate(${b}deg)`; // la carte tourne de +b : le nord aussi
  $('btnNorth').classList.toggle('rotated', Math.abs(((b % 360) + 360) % 360) > 0.5);
}
let rotT = 0;
map.on('rotate', () => { syncCompass(); rotateGateIcons(); current.bearing = map.getBearing(); clearTimeout(rotT); rotT = setTimeout(persist, 400); });

const fig = L.layerGroup().addTo(map);
const grads = L.layerGroup().addTo(map);
let markerA = null, markerB = null, placing = null, posMarker = null; // placing : null | 'A' | 'B'

function dotIcon(color, size, label, cls) {
  return L.divIcon({
    className: 'dot ' + (cls || ''),
    html: `<span style="background:${color};width:${size}px;height:${size}px"></span>${label ? `<b class="${isDark(color) ? 'onlight' : ''}" style="color:${color}">${label}</b>` : ''}`,
    iconSize: [size, size], iconAnchor: [size / 2, size / 2]
  });
}
const LL = p => [p.lat, p.lng];

let raf = 0;
function redraw() { cancelAnimationFrame(raf); raf = requestAnimationFrame(draw); }
let lightT = 0;
function drawLight() { const n = performance.now(); if (n - lightT > 60) { lightT = n; draw(); } }

function arrowAt(from, to, frac, size) {
  // petite flèche (chevron) au point frac du segment from→to, en coordonnées locales de from
  const v = Geo.toLocal(from, to), n = Math.hypot(v.x, v.y) || 1, u = { x: v.x / n, y: v.y / n }, w = { x: -u.y, y: u.x };
  const m = { x: v.x * frac, y: v.y * frac };
  const a = s => Geo.fromLocal(from, { x: m.x - u.x * size + s * w.x * size * 0.6, y: m.y - u.y * size + s * w.y * size * 0.6 });
  return [LL(a(-1)), LL(Geo.fromLocal(from, m)), LL(a(1))];
}

function draw() {
  fig.clearLayers(); grads.clearLayers();
  if ((typeof Photo !== 'undefined')) Photo.sync();
  updateLegend(); updateAxisInfo(); syncQuick();
  if (!hasGates()) {
    if (!placing && current.gateA) placing = current.single ? 'SD' : 'B'; // il manque la 2e porte, ou la direction de la porte unique
    if (placing) placeBanner();
    else setBanner('Pour commencer : ☰ → ＋ Nouvelle zone.');
    syncPlaceBtn();
    if (current.gateA) placeGateMarkers();
    return;
  }
  if (!placing) setBanner(null);
  syncPlaceBtn();
  const p = current.params;

  // Couloir A–B + prolongements derrière chaque porte jusqu'au point de snap
  if (current.single) { if (current.show !== 'none') L.polyline([LL(current.gateA), LL(current.gateB)], { color: GATE_COLOR, weight: 2, dashArray: '6 6', opacity: .9, interactive: false }).addTo(fig); }
  else if (current.show !== 'none') L.polyline([LL(current.gateA), LL(current.gateB)], { color: AXIS_COLOR, weight: 3, opacity: .95, interactive: false }).addTo(fig);
  configs().forEach(c => {
    const col = c.colors;
    if (showRec()) L.polyline([LL(c.behind), LL(c.gate)], { color: AXIS_COLOR, weight: 2, dashArray: '8 6', opacity: .9, interactive: false }).addTo(fig);
    // Flèche du sens du poser depuis cette porte
    const other = c.key === 'A' ? current.gateB : current.gateA;
    const len = Math.min(25, corridorLength() * 0.3);
    const tip = Geo.fromLocal(c.gate, { x: c.geo.f.x * len, y: c.geo.f.y * len });
    L.polyline(arrowAt(c.gate, tip, 1, Math.max(len * 0.3, 4)), { color: GATE_COLOR, weight: 3, interactive: false }).addTo(fig);
    void other;

    // Étape de base (branche d'approche avant le setup)
    if ((+p.legLen || 0) > 0) {
      L.polyline([LL(c.legStart), LL(c.setup)], { color: '#fff', weight: 6, opacity: .75, interactive: false }).addTo(fig);
      L.polyline([LL(c.legStart), LL(c.setup)], { color: col.leg, weight: 3, interactive: false }).addTo(fig);
      const chev = arrowAt(c.legStart, c.setup, 0.55, Math.min(10, (+p.legLen || 0) * 0.08 + 3));
      L.polyline(chev, { color: '#fff', weight: 6, opacity: .75, interactive: false }).addTo(fig);
      L.polyline(chev, { color: col.leg, weight: 3, interactive: false }).addTo(fig);
      L.marker(LL(c.legStart), { icon: dotIcon(col.leg, 10, showLabels() ? `${legLine1(c)}<br><small>${legLine2(c)}</small>` : ''), interactive: false }).addTo(fig);
    }
    if (showRec()) L.polyline([LL(c.setup), LL(c.rec)], { color: '#fff', weight: 1, opacity: .45, dashArray: '2 6', interactive: false }).addTo(fig);

    drawWindCircle(c.setup, c.geo.rSetup, col.setup);
    if (showRec()) drawWindCircle(c.rec, c.geo.rRec, col.rec);
    L.marker(LL(c.setup), { icon: dotIcon(col.setup, 14, showLabels() ? `Setup ${cfgName(c)}` : ''), interactive: false }).addTo(fig);
    if (showRec()) L.marker(LL(c.rec), { icon: dotIcon(col.rec, 11, showLabels() ? `Snap ${cfgName(c)}` : ''), interactive: false }).addTo(fig);
  });
  placeGateMarkers();
}

function legLine1(c) { const p = current.params; return `Base ${cfgName(c)} · ${p.legLen} m` + (+p.legTime ? ` · ${p.legTime} s` : ''); }
function legLine2(c) { const p = current.params; return `cap ${Math.round(c.geo.legHeading)}°` + (+p.legHeight ? ` · début à ${p.legHeight} m` : ''); }

function drawWindCircle(center, radius, color) {
  if (!(radius > 0)) return;
  const p = current.params;
  L.circle(LL(center), { radius, color, weight: 2.5, fill: true, fillOpacity: .06, interactive: false }).addTo(fig);
  if (p.rings) {
    const v = +p.vref || 5;
    for (let k = 1; k < v; k++)
      L.circle(LL(center), { radius: radius * k / v, color, weight: 1, opacity: .55, fill: false, dashArray: '3 5', interactive: false }).addTo(fig);
  }
  if (p.ticks === false) return; // version épurée
  const mpp = 40075016.686 * Math.cos(center.lat * Math.PI / 180) / Math.pow(2, map.getZoom() + 8);
  const degs = Geo.degTicks(radius / mpp);
  const pt = (deg, d) => { const a = deg * Math.PI / 180; return LL(Geo.fromLocal(center, { x: d * Math.sin(a), y: d * Math.cos(a) })); };
  const segs = [];
  degs.forEach(deg => { // un trait + le chiffre à l'extérieur du cercle (les degrés restent affichés même sans les autres textes)
    segs.push([pt(deg, radius), pt(deg, radius - 10 * mpp)]);
    L.marker(pt(deg, radius + 15 * mpp), { interactive: false,
      icon: L.divIcon({ className: 'glabel', html: `<span style="color:${color}">${deg}°</span>`, iconSize: [0, 0] }) }).addTo(grads);
  });
  L.polyline(segs, { color, weight: 1.5, interactive: false }).addTo(grads);
}

const isDragging = m => !!(m && (m._lpDragging || (m.dragging && m.dragging._draggable && m.dragging._draggable._moving)));

// ---------- Appui long pour déplacer un point (portes, mesure) ----------
// Un glissement immédiat déplace la carte ; il faut rester appuyé HOLD_MS sans bouger pour « soulever » le point.
const HOLD_MS = 450, MOVE_TOL = 10;
let suppressClickUntil = 0;
function longPressDrag(marker, onMove, onEnd, onStart) {
  const el = marker.getElement(); if (!el) return;
  let timer = null, start = null;
  const pt = e => (e.touches ? (e.touches[0] || e.changedTouches[0]) : e);
  const off = () => {
    document.removeEventListener('touchmove', move); document.removeEventListener('mousemove', move);
    document.removeEventListener('touchend', up); document.removeEventListener('touchcancel', up); document.removeEventListener('mouseup', up);
  };
  const down = e => {
    if (e.touches && e.touches.length > 1) return; // deux doigts : c'est pour la carte
    const p = pt(e); start = { x: p.clientX, y: p.clientY };
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null; marker._lpDragging = true; if (onStart) onStart();
      const d = map.dragging && map.dragging._draggable; if (d) d.finishDrag(true); // stoppe le déplacement de carte commencé
      map.dragging.disable(); el.classList.add('lifting');
      if (navigator.vibrate) try { navigator.vibrate(25); } catch (er) {}
    }, HOLD_MS);
    document.addEventListener('touchmove', move, { passive: false }); document.addEventListener('mousemove', move);
    document.addEventListener('touchend', up); document.addEventListener('touchcancel', up); document.addEventListener('mouseup', up);
  };
  const move = e => {
    if (e.touches && e.touches.length > 1) { clearTimeout(timer); timer = null; return; }
    const p = pt(e); if (!p) return;
    if (!marker._lpDragging) {
      if (timer && Math.hypot(p.clientX - start.x, p.clientY - start.y) > MOVE_TOL) { clearTimeout(timer); timer = null; }
      return;
    }
    e.preventDefault();
    const r = map.getContainer().getBoundingClientRect();
    const ll = map.containerPointToLatLng([p.clientX - r.left, p.clientY - r.top]);
    marker.setLatLng(ll); onMove({ lat: ll.lat, lng: ll.lng });
  };
  const up = () => {
    clearTimeout(timer); timer = null; off();
    if (marker._lpDragging) {
      marker._lpDragging = false; el.classList.remove('lifting'); map.dragging.enable();
      suppressClickUntil = Date.now() + 400; onEnd();
    }
  };
  el.addEventListener('touchstart', down, { passive: true }); el.addEventListener('mousedown', down);
}
// Icône des portes : petit segment perpendiculaire à l'axe de poser, avec un drapeau debout à chaque bout
// (drapeaux toujours droits à l'écran, le segment suit l'orientation de l'axe et de la carte).
function gateSvg(theta) { // theta : angle à l'écran du sens du poser (0 = haut, sens horaire)
  const t = theta * Math.PI / 180, px = Math.cos(t), py = Math.sin(t), W2 = 15;
  const ends = [-1, 1].map(sd => [sd * px * W2, sd * py * W2]);
  const flag = ([x, y]) => `<line x1="${x}" y1="${y}" x2="${x}" y2="${y - 18}" stroke="#111" stroke-width="2"/>
    <polygon points="${x},${y - 18} ${x + 11},${y - 14} ${x},${y - 10}" fill="${GATE_COLOR}" stroke="#111" stroke-width="1.2"/>`;
  return `<line x1="${ends[0][0]}" y1="${ends[0][1]}" x2="${ends[1][0]}" y2="${ends[1][1]}" stroke="#000" stroke-width="6" stroke-linecap="round" opacity=".5"/>
    <line x1="${ends[0][0]}" y1="${ends[0][1]}" x2="${ends[1][0]}" y2="${ends[1][1]}" stroke="${GATE_COLOR}" stroke-width="3.5" stroke-linecap="round"/>
    ${ends.map(flag).join('')}
    ${ends.map(([x, y]) => `<circle cx="${x}" cy="${y}" r="2.5" fill="#fff" stroke="#111"/>`).join('')}`;
}
function gateIcon(label) {
  return L.divIcon({ className: 'gate', iconSize: [34, 34], iconAnchor: [17, 17],
    html: `<svg class="gsvg" width="60" height="60" viewBox="-30 -30 60 60"></svg>${label ? `<b style="color:${GATE_COLOR}">${label}</b>` : ''}` });
}
function rotateGateIcons() {
  const b = map.getBearing ? map.getBearing() : 0;
  [['A', markerA], ['B', markerB]].forEach(([k, m]) => {
    const el = m && m.getElement && m.getElement(); if (!el) return;
    const asvg = el.querySelector('.asvg');
    if (asvg) { // flèche de cap (porte unique)
      asvg.innerHTML = `<g transform="rotate(${(hasGates() ? axisHeading() : 0) + b})"><circle r="17" fill="rgba(0,0,0,.45)" stroke="#fff" stroke-width="2"/><path d="M0,-12 L9,6 L0,1 L-9,6 Z" fill="${GATE_COLOR}" stroke="#000" stroke-width="1"/></g>`;
      return;
    }
    const svg = el.querySelector('.gsvg'); if (!svg) return;
    svg.innerHTML = gateSvg((hasGates() ? headingOf(k) : 0) + b);
  });
}
function gateLabel(key) { return showLabels() && hasGates() ? `Portes ${cardOf(headingOf(key))}` : ''; }
// Glisser une porte ou le rond du milieu déplace TOUT le couloir : cap et longueur conservés.
// (Pour changer une seule porte : boutons « Porte 1 / Porte 2 » de l'onglet Portes.)
let corrVec = null, markerMid = null;
function corridorDrag(m, where) { // where : 'A', 'B' ou 'M' (milieu)
  longPressDrag(m, ll => {
    if (!corrVec) return;
    const v = corrVec;
    if (where === 'A') { current.gateA = ll; current.gateB = Geo.fromLocal(ll, v); }
    else if (where === 'B') { current.gateB = ll; current.gateA = Geo.fromLocal(ll, { x: -v.x, y: -v.y }); }
    else { current.gateA = Geo.fromLocal(ll, { x: -v.x / 2, y: -v.y / 2 }); current.gateB = Geo.fromLocal(ll, { x: v.x / 2, y: v.y / 2 }); }
    drawLight();
  }, () => { corrVec = null; persist(); redraw(); },
  () => { corrVec = hasGates() ? Geo.toLocal(current.gateA, current.gateB) : null; });
}
// Porte unique : la « 2e porte » n'existe pas ; B est la pointe d'une flèche de cap à SINGLE_LEN m devant la porte.
const SINGLE_LEN = 60;
function singleTip(a, headingDeg) { const r = headingDeg * Math.PI / 180; return Geo.fromLocal(a, { x: SINGLE_LEN * Math.sin(r), y: SINGLE_LEN * Math.cos(r) }); }
function arrowIcon() {
  return L.divIcon({ className: 'sarrow', iconSize: [44, 44], iconAnchor: [22, 22],
    html: `<svg class="asvg" width="44" height="44" viewBox="-22 -22 44 44"></svg>` });
}
function makeArrowMarker() {
  const m = L.marker(LL(current.gateB), { draggable: false, icon: arrowIcon(), zIndexOffset: 1000 }).addTo(map);
  longPressDrag(m, ll => { // tourner le cap autour de la porte
    const v = Geo.toLocal(current.gateA, ll); if (Math.hypot(v.x, v.y) < 3) return;
    current.gateB = singleTip(current.gateA, Geo.bearingOf(v)); drawLight();
  }, () => { persist(); redraw(); });
  return m;
}
// Appui long sur une porte : on ne déplace QUE cette porte (le cap et la longueur du couloir suivent).
// En porte unique, la porte emmène sa flèche de cap avec elle.
function makeGateMarker(key) {
  if (key === 'B' && current.single) return makeArrowMarker();
  const m = L.marker(LL(current['gate' + key]), { draggable: false, icon: gateIcon(gateLabel(key)), zIndexOffset: 1000 }).addTo(map);
  m._psvLabel = gateLabel(key);
  let vec = null;
  longPressDrag(m, ll => {
    if (current.single && vec) { current.gateA = ll; current.gateB = Geo.fromLocal(ll, vec); }
    else current['gate' + key] = ll;
    drawLight();
  }, () => { vec = null; persist(); redraw(); },
  () => { vec = current.single && hasGates() ? Geo.toLocal(current.gateA, current.gateB) : null; });
  return m;
}
// Appui long sur le trait blanc du couloir : on déplace tout le couloir (portes comprises), cap et longueur conservés.
let corrHit = null;
function corridorHit() {
  if (corrHit) return corrHit;
  const line = L.polyline([[0, 0], [0, 0]], { color: '#fff', weight: 30, opacity: 0, interactive: true, bubblingMouseEvents: true });
  const handle = { line, _lpDragging: false, getElement: () => line._path, setLatLng: () => {} };
  let ref = null, a0 = null, b0 = null;
  corrHit = { line, handle, attached: false };
  corrHit.attach = () => {
    if (corrHit.attached || !line._path) return; corrHit.attached = true;
    longPressDrag(handle, ll => {
      if (!ref) { ref = ll; a0 = current.gateA; b0 = current.gateB; return; }
      const d = Geo.toLocal(ref, ll);
      current.gateA = Geo.fromLocal(a0, d); current.gateB = Geo.fromLocal(b0, d); drawLight();
    }, () => { ref = null; persist(); redraw(); }, () => { ref = null; });
  };
  return corrHit;
}
function syncCorridorHit() {
  const h = corridorHit();
  if (hasGates() && !current.single) {
    if (!handleDragging()) h.line.setLatLngs([LL(current.gateA), LL(current.gateB)]);
    if (!map.hasLayer(h.line)) h.line.addTo(map);
    h.attach();
  } else if (map.hasLayer(h.line)) map.removeLayer(h.line);
}
const handleDragging = () => !!(corrHit && corrHit.handle._lpDragging);
const midIcon = L.divIcon({ className: 'corrmid', iconSize: [38, 38], iconAnchor: [19, 19], html: '<span></span>' });
function corridorMid() { return { lat: (current.gateA.lat + current.gateB.lat) / 2, lng: (current.gateA.lng + current.gateB.lng) / 2 }; }
function syncGate(m, key) {
  if (isDragging(m)) return; // le point tenu au doigt est placé par le glissement lui-même
  m.setLatLng(LL(current['gate' + key]));
  if (key === 'B' && current.single) return;
  const lab = gateLabel(key);
  if (m._psvLabel !== lab) { m.setIcon(gateIcon(lab)); m._psvLabel = lab; }
}
function placeGateMarkers() {
  if (current.gateA) { if (!markerA) markerA = makeGateMarker('A'); else syncGate(markerA, 'A'); }
  const hideTip = current.single && current.show === 'none';
  if (hideTip && markerB) { map.removeLayer(markerB); markerB = null; }
  if (current.gateB && !hideTip) { if (!markerB) markerB = makeGateMarker('B'); else syncGate(markerB, 'B'); }
  syncCorridorHit();
  rotateGateIcons();
}
function resetGateMarkers() {
  [markerA, markerB, markerMid].forEach(m => m && map.removeLayer(m));
  markerA = markerB = markerMid = null;
  if (corrHit && map.hasLayer(corrHit.line)) map.removeLayer(corrHit.line);
}

// Cadre la figure dans la partie libre de l'écran (hors barre du haut, boutons de gauche, zoom),
// en tenant compte de la rotation de la carte (fitBounds de Leaflet l'ignore).
function freeRect() {
  const W = map.getSize().x, H = map.getSize().y, m = 14;
  const top = $('top').getBoundingClientRect(), quick = $('quick').getBoundingClientRect();
  return { l: Math.max(m, quick.right + m), t: Math.max(m, top.bottom + m), r: W - 64, b: H - 40 };
}
function fitFigure() {
  const pts = figurePoints(); if (pts.length < 2) return;
  map.invalidateSize({ animate: false }); // taille réelle de l'écran (portrait / paysage)
  for (let pass = 0; pass < 2; pass++) { // 2 passes : la 2e corrige les arrondis du zoom
    const P = pts.map(p => map.latLngToContainerPoint(LL(p)));
    const x0 = Math.min(...P.map(p => p.x)), x1 = Math.max(...P.map(p => p.x));
    const y0 = Math.min(...P.map(p => p.y)), y1 = Math.max(...P.map(p => p.y));
    const R = freeRect(), aw = Math.max(80, R.r - R.l), ah = Math.max(80, R.b - R.t);
    const k = Math.min(aw / Math.max(x1 - x0, 1), ah / Math.max(y1 - y0, 1));
    const z = Math.min(19, Math.floor((map.getZoom() + Math.log2(k)) * 4) / 4);
    const centerLL = map.containerPointToLatLng([(x0 + x1) / 2, (y0 + y1) / 2]);
    map.setView(centerLL, z, { animate: false });
    // décale pour que le centre de la figure tombe au centre de la zone libre
    const S = map.getSize(), cx = S.x / 2, cy = S.y / 2, ax = (R.l + R.r) / 2, ay = (R.t + R.b) / 2;
    map.panBy([cx - ax, cy - ay], { animate: false });
  }
}

function updateLegend() {
  const p = current.params, t = (+p.t1 || 0) + (+p.t2 || 0), r0 = Math.round;
  let h = '';
  configs().forEach(c => {
    h += `<div><i style="background:${c.colors.setup}"></i>${cfgName(c)} : poser au ${hdg(c.heading)}, virage à ${c.turn === 'G' ? 'gauche' : 'droite'}</div>`;
  });
  h += `<div class="mut">Cercles 5 m/s : setup ${r0((+p.vref || 0) * t)} m · snap ${r0((+p.vref || 0) * (+p.t2 || 0))} m</div>`;
  h += `<div class="mut">1 m/s = ${r0(t)} m (setup) · ${r0(+p.t2 || 0)} m (snap)</div>`;
  $('legend').innerHTML = h;
  $('legend').classList.toggle('hidden', !showLabels());
}
function updateAxisInfo() {
  $('axisInfo').textContent = !hasGates() ? 'Portes pas encore placées.'
    : current.single ? `Porte unique · axe de poser ${hdg(axisHeading())} (${cardOf(axisHeading())}). Pour changer le cap : appui long sur la flèche et tourne, ou saisis-le ci-dessous.`
    : `Axes de poser : ${hdg(axisHeading())} et ${hdg((axisHeading() + 180) % 360)} · couloir ${Math.round(corridorLength())} m`;
  $('lenRow').classList.toggle('hidden', !!current.single);
  $('capLabel').textContent = current.single ? 'Cap du poser (°)' : 'Cap 1re → 2e porte (°)';
  if (hasGates()) {
    if (document.activeElement !== $('c_heading')) $('c_heading').value = Math.round(axisHeading()) % 360;
    if (document.activeElement !== $('c_len')) $('c_len').value = Math.round(corridorLength());
  }
}

// ---------- Interface ----------
// Élément absent (ex. page en cache d'une version plus ancienne) : on renvoie un élément fantôme
// plutôt que de planter toute l'appli.
function $(id) { return document.getElementById(id) || document.createElement('div'); }
function setBanner(t) { const b = $('banner'); if (!t) b.classList.add('hidden'); else { b.textContent = t; b.classList.remove('hidden'); } }
let toastT;
function toast(t) { const el = $('toast'); el.textContent = t; el.classList.remove('hidden'); clearTimeout(toastT); toastT = setTimeout(() => el.classList.add('hidden'), 2800); }

const numFields = ['t1', 't2', 'setupBack', 'setupSide', 'recBack', 'vref', 'legTime', 'legSpeed', 'legHeight', 'setupHeight'];
const MEMO_FIELDS = ['legHeight', 'setupHeight']; // aide-mémoire : peuvent rester vides
function fillInputs(only) {
  const p = current.params;
  (only || numFields).forEach(k => { const el = $('p_' + k); if (el && document.activeElement !== el) el.value = p[k] == null ? '' : p[k]; });
  $('legInfo').textContent = `Longueur tracée : ${legLenOf(p)} m (${p.legTime} s × ${p.legSpeed} m/s)`;
  if (only) return;
  syncQuick();
  $('zoneName').textContent = current.name + (current.id ? '' : ' (non enregistrée)');
}
numFields.forEach(k => {
  $('p_' + k).addEventListener('input', e => {
    const raw = String(e.target.value).trim();
    let v = parseFloat(raw.replace(',', '.'));
    if (isNaN(v)) { if (raw === '' && MEMO_FIELDS.includes(k)) v = null; else return; }
    current.params[k] = v;
    if (k === 'legTime' || k === 'legSpeed') { current.params.legLen = legLenOf(current.params); profile.legLen = current.params.legLen; $('legInfo').textContent = `Longueur tracée : ${current.params.legLen} m (${current.params.legTime} s × ${current.params.legSpeed} m/s)`; }
    if (PROFILE_KEYS.includes(k)) { // réglage de manœuvre : toutes les zones suivent
      profile[k] = v; store.set('psv.profile', profile);
      zones.forEach(applyProfile); store.set('psv.zones', zones);
    }
    persist(); redraw();
  });
  $('p_' + k).addEventListener('blur', () => fillInputs([k]));
});
// ---------- Bascules rapides sur la carte ----------
function syncQuick() {
  const p = current.params, sh = current.show;
  const h = k => hasGates() ? cardOf(headingOf(k)) : (k === 'A' ? 'P1' : 'P2');
  const t = k => `${h(k)} ${current['turn' + k] === 'G' ? '↺ G' : '↻ D'}`;
  $('qTurnA').textContent = t('A'); $('qTurnB').textContent = t('B');
  $('qShowB').classList.toggle('hidden', !!current.single); $('qTurnB').classList.toggle('hidden', !!current.single);
  $('qShowA').classList.toggle('on', current.single ? sh !== 'none' : (sh === 'AB' || sh === 'A')); $('qShowB').classList.toggle('on', sh === 'AB' || sh === 'B');
  $('qShowA').textContent = '👁 ' + h('A'); $('qShowB').textContent = '👁 ' + h('B');
  $('qRec').classList.toggle('on', showRec());
  $('qTicks').classList.toggle('on', p.ticks !== false); $('qRings').classList.toggle('on', !!p.rings);
}
function quick(fn, msg) { fn(); syncQuick(); persist(); redraw(); if (msg) toast(msg()); }
$('qTurnA').addEventListener('click', () => quick(() => { current.turnA = current.turnA === 'G' ? 'D' : 'G'; }, () => `${cfgNameKey('A')} : virage à ${current.turnA === 'G' ? 'gauche' : 'droite'}`));
$('qTurnB').addEventListener('click', () => quick(() => { current.turnB = current.turnB === 'G' ? 'D' : 'G'; }, () => `${cfgNameKey('B')} : virage à ${current.turnB === 'G' ? 'gauche' : 'droite'}`));
function toggleShow(k) {
  if (current.single) { // porte unique : l'œil masque tout sauf la porte (axe, étape de base, points, cercles)
    quick(() => { current.show = current.show === 'none' ? 'AB' : 'none'; }, () => current.show === 'none' ? 'Configuration masquée' : 'Configuration affichée');
    return;
  }
  const sh = current.show || 'AB';
  const vis = { A: sh === 'AB' || sh === 'A', B: sh === 'AB' || sh === 'B' };
  vis[k] = !vis[k];
  // les deux yeux fermés : on ne garde que les portes (couloir, étapes de base, points et cercles masqués)
  quick(() => { current.show = vis.A && vis.B ? 'AB' : vis.A ? 'A' : vis.B ? 'B' : 'none'; });
}
$('qShowA').addEventListener('click', () => toggleShow('A'));
$('qShowB').addEventListener('click', () => toggleShow('B'));
$('qTicks').addEventListener('click', () => quick(() => { current.params.ticks = current.params.ticks === false; }, () => current.params.ticks ? 'Graduations affichées' : 'Graduations masquées'));
$('qRec').addEventListener('click', () => quick(() => { current.params.rec = !showRec(); }, () => showRec() ? 'Point de snap affiché' : 'Point de snap masqué'));
$('qRings').addEventListener('click', () => quick(() => { current.params.rings = !current.params.rings; }, () => current.params.rings ? 'Anneaux 1 m/s affichés' : 'Anneaux 1 m/s masqués'));
// Couloir : la 1re porte reste fixe, on place la 2e au cap et à la distance voulus
function setCorridor(headingDeg, lengthM) {
  if (!hasGates()) return toast('Place d\'abord les deux portes');
  const h = ((headingDeg % 360) + 360) % 360 * Math.PI / 180, d = Math.max(1, lengthM);
  current.gateB = current.single ? singleTip(current.gateA, h * 180 / Math.PI) : Geo.fromLocal(current.gateA, { x: d * Math.sin(h), y: d * Math.cos(h) });
  persist(); redraw();
}
document.querySelectorAll('[data-rot]').forEach(b => b.addEventListener('click', () => {
  if (hasGates()) setCorridor(Math.round(axisHeading()) + +b.dataset.rot, corridorLength());
}));
document.querySelectorAll('[data-len]').forEach(b => b.addEventListener('click', () => {
  if (hasGates()) setCorridor(axisHeading(), Math.round(corridorLength()) + +b.dataset.len);
}));
const numIn = el => parseFloat(String(el.value).replace(',', '.'));
$('c_heading').addEventListener('change', e => { const v = numIn(e.target); if (!isNaN(v) && hasGates()) setCorridor(v, corridorLength()); });
$('c_len').addEventListener('change', e => { const v = numIn(e.target); if (!isNaN(v) && v > 0 && hasGates()) setCorridor(axisHeading(), v); });
['c_heading', 'c_len'].forEach(id => $(id).addEventListener('keydown', e => { if (e.key === 'Enter') e.target.blur(); }));


function syncPlaceBtn() {
  const two = !current.single;
  $('btnPlaceA').classList.toggle('on', placing === 'A' || (two && hasGates() && !placing));
  $('btnPlaceB').classList.toggle('on', placing === 'B' || (two && hasGates() && !placing));
  $('btnPlaceS').classList.toggle('on', placing === 'S' || placing === 'SD' || (!two && hasGates() && !placing));
  const lab = k => two && hasGates() ? `📍 Porte ${k === 'A' ? 1 : 2} (${cardOf(headingOf(k))})` : `📍 Porte ${k === 'A' ? 1 : 2}`;
  $('btnPlaceA').textContent = lab('A'); $('btnPlaceB').textContent = lab('B');
  $('btnPlaceS').textContent = !two && hasGates() ? `📍 Porte unique (${cardOf(axisHeading())})` : '📍 Porte unique';
  $('placeHint').textContent = two
    ? 'Touche un bouton puis la carte pour (re)placer cette porte. Appui long sur une porte pour déplacer cette porte seule ; appui long sur le trait blanc entre les portes pour déplacer tout le couloir (cap et longueur conservés).'
    : 'Porte unique : un seul axe de poser. Appui long sur la porte pour la déplacer, sur la flèche pour tourner le cap. « Porte 1 » ou « Porte 2 » repasse en couloir à deux portes.';
}
function placeBanner() { setBanner(!placing ? null : placing === 'S' ? 'Touche la carte pour placer la porte unique.' : placing === 'SD' ? 'Touche la carte dans la direction du poser (n\'importe quelle distance).' : `Touche la carte pour placer la porte ${placing === 'A' ? 1 : 2}.`); }
['A', 'B', 'S'].forEach(k => $('btnPlace' + k).addEventListener('click', () => {
  if (placing === k) { placing = null; placeBanner(); syncPlaceBtn(); return; } // 2e appui : annule
  if (k !== 'S' && current.single) { // retour au couloir à deux portes : la flèche de cap disparaît
    current.single = false; current.gateB = null; current.show = 'AB'; resetGateMarkers(); persist(); redraw();
  }
  stopMeasure(); placing = k; syncPlaceBtn(); placeBanner(); closeSheet();
}));
// ---------- Mesure : cap et distance entre deux points touchés (dans l'ordre) ----------
const measLayer = L.layerGroup().addTo(map);
const meas = { active: false, a: null, b: null, ma: null, mb: null, line: null, halo: null, lbl: null };
function capDeg(a, b) { // cap initial (orthodromie) de a vers b, en degrés
  const r = Math.PI / 180, f1 = a.lat * r, f2 = b.lat * r, dl = (b.lng - a.lng) * r;
  const y = Math.sin(dl) * Math.cos(f2), x = Math.cos(f1) * Math.sin(f2) - Math.sin(f1) * Math.cos(f2) * Math.cos(dl);
  return (Math.atan2(y, x) / r + 360) % 360;
}
function fmtDist(m) { return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(2).replace('.', ',')} km`; }
function measBox(t) { const b = $('measureBox'); if (!t) b.classList.add('hidden'); else { b.innerHTML = t; b.classList.remove('hidden'); } }
function stopMeasure() {
  Object.assign(meas, { active: false, a: null, b: null, ma: null, mb: null, line: null, halo: null, lbl: null });
  measLayer.clearLayers(); measBox(null); $('qMeasure').classList.remove('on');
}
$('qMeasure').addEventListener('click', () => {
  if (meas.active) { stopMeasure(); return; }
  if (placing) return toast('Termine d\'abord le placement des portes');
  meas.active = true; $('qMeasure').classList.add('on');
  measBox('Mesure : touche le <b>1er point</b>');
});
// Points de mesure déplaçables (comme les portes) : la mesure se met à jour pendant le glissement
const measIcon = L.divIcon({ className: 'measpt', iconSize: [34, 34], iconAnchor: [17, 17], html: '<span></span>' });
function measMarker(key) {
  const m = L.marker(LL(meas[key]), { draggable: false, icon: measIcon, zIndexOffset: 900 }).addTo(measLayer);
  longPressDrag(m, ll => { meas[key] = ll; updateMeasure(); }, () => {});
  return m;
}
function updateMeasure() {
  if (!meas.a || !meas.b) return;
  const a = meas.a, b = meas.b, d = map.distance(LL(a), LL(b)), c = capDeg(a, b), mid = [(a.lat + b.lat) / 2, (a.lng + b.lng) / 2];
  const txt = `${hdg(c)} · ${fmtDist(d)}`;
  if (!meas.line) {
    meas.halo = L.polyline([LL(a), LL(b)], { color: '#000', weight: 5, opacity: .5, interactive: false }).addTo(measLayer);
    meas.line = L.polyline([LL(a), LL(b)], { color: '#00e5ff', weight: 3, dashArray: '8 6', interactive: false }).addTo(measLayer);
    meas.lbl = L.marker(mid, { interactive: false, icon: L.divIcon({ className: 'measlbl', iconSize: [0, 0], html: `<span>${txt}</span>` }) }).addTo(measLayer);
  } else {
    meas.halo.setLatLngs([LL(a), LL(b)]); meas.line.setLatLngs([LL(a), LL(b)]); meas.lbl.setLatLng(mid);
    const el = meas.lbl.getElement && meas.lbl.getElement(); if (el) el.querySelector('span').textContent = txt;
  }
  measBox(`<b>Cap ${hdg(c)} · ${fmtDist(d)}</b><br><small>Appui long sur un point puis glisse pour ajuster · 📏 = effacer</small>`);
}
function measureClick(p) {
  if (!meas.a) { meas.a = p; meas.ma = measMarker('a'); measBox('Mesure : touche le <b>2e point</b>'); return; }
  if (!meas.b) { meas.b = p; meas.mb = measMarker('b'); updateMeasure(); }
  // une fois les deux points posés, on les déplace au doigt ; un appui sur la carte ne fait rien
}
map.on('click', e => {
  if (Date.now() < suppressClickUntil) return; // fin d'un déplacement de point : pas un appui
  if ((typeof Photo !== 'undefined') && Photo.onMapClick(e)) return; // calage d'une photo aérienne en cours
  if (!placing && meas.active) { measureClick({ lat: e.latlng.lat, lng: e.latlng.lng }); return; }
  if (!placing) return;
  const p = { lat: e.latlng.lat, lng: e.latlng.lng };
  if (placing === 'S') { // porte unique : on pose la porte puis on demande le cap
    current.single = true; current.show = 'AB'; current.gateA = p; current.gateB = null;
    placing = 'SD'; placeBanner(); resetGateMarkers(); syncPlaceBtn(); persist(); redraw();
    return;
  }
  if (placing === 'SD') { // 2e appui : la direction porte → point touché donne l'axe de poser (distance indifférente)
    const v = Geo.toLocal(current.gateA, p);
    if (Math.hypot(v.x, v.y) < 1) return;
    current.gateB = singleTip(current.gateA, Geo.bearingOf(v));
    placing = null; placeBanner(); resetGateMarkers(); syncPlaceBtn(); persist(); redraw(); fitFigure();
    toast(`Axe de poser ${hdg(axisHeading())} (${cardOf(axisHeading())}). Appui long sur la flèche pour l'ajuster.`);
    return;
  }
  current['gate' + placing] = p;
  const other = placing === 'A' ? 'B' : 'A';
  placing = current['gate' + other] ? null : other; // l'autre porte manque encore : on enchaîne
  placeBanner();
  if (!placing) toast('Couloir placé. Appui long : sur une porte pour la déplacer, sur le trait blanc pour déplacer le couloir.');
  syncPlaceBtn(); persist(); redraw();
});
map.on('zoomend', redraw);
(function delayTouchRotate() {
  const TG = map.touchGestures; if (!TG || !TG._onTouchStart) return;
  const ROT_HOLD_MS = 300, ROT_TOL = 12; // doigts quasi immobiles pendant 0,3 s → la rotation s'active
  const cp = t => map.mouseEventToContainerPoint(t);
  const origStart = TG._onTouchStart, origMove = TG._onTouchMove;
  TG._onTouchStart = function (e) {
    origStart.call(this, e);
    this._rotPending = null;
    if (this._rotating) { // le plug-in voulait tourner tout de suite : on met en attente
      this._rotating = false;
      this._rotPending = { t: Date.now(), p1: cp(e.touches[0]), p2: cp(e.touches[1]) };
    }
  };
  TG._onTouchMove = function (e) {
    const rp = this._rotPending;
    if (rp && e.touches && e.touches.length === 2) {
      const p1 = cp(e.touches[0]), p2 = cp(e.touches[1]);
      const d = Math.max(p1.distanceTo(rp.p1), p2.distanceTo(rp.p2));
      if (d > ROT_TOL) {
        if (Date.now() - rp.t >= ROT_HOLD_MS) { // doigts restés immobiles assez longtemps : on tourne
          const v = rp.p1.subtract(rp.p2);
          this._startTheta = Math.atan(v.x / v.y);
          this._startBearing = map.getBearing() + (v.y < 0 ? 180 : 0);
          this._rotating = true;
        }
        this._rotPending = null; // sinon : déplacement / zoom à deux doigts, sans rotation
      }
    }
    return origMove.call(this, e);
  };
  TG.disable(); TG.enable(); // ré-abonne les écouteurs aux versions modifiées
})();
// Rotation du téléphone : Leaflet doit relire la taille de l'écran
['resize', 'orientationchange'].forEach(ev => window.addEventListener(ev, () => setTimeout(() => map.invalidateSize({ animate: false }), 250)));

let sheetSize = 'full';
function setSheetSize(sz) { sheetSize = sz; $('sheet').classList.toggle('mini', sz === 'mini'); $('sheet').classList.toggle('full', sz === 'full'); }
(function sheetGrab() {
  const g = $('grab'); let y0 = null, moved = false;
  const start = y => { y0 = y; moved = false; };
  const end = y => {
    if (y0 === null) return; const dy = y - y0; y0 = null;
    if (Math.abs(dy) < 12) { setSheetSize(sheetSize === 'full' ? 'mini' : 'full'); return; } // simple toucher : bascule
    if (dy < 0) setSheetSize('full');                                        // vers le haut : grand
    else if (sheetSize === 'full') setSheetSize('mini');                     // vers le bas : réduit…
    else closeSheet();                                                       // …puis fermé
  };
  g.addEventListener('touchstart', e => start(e.touches[0].clientY), { passive: true });
  g.addEventListener('touchend', e => end(e.changedTouches[0].clientY));
  g.addEventListener('mousedown', e => start(e.clientY));
  window.addEventListener('mouseup', e => end(e.clientY));
})();
let lastTab = 'reglages';
function openSheet(tab) {
  lastTab = tab;
  $('sheet').classList.remove('hidden'); setSheetSize(sheetSize);
  document.querySelectorAll('.tabs [data-tab]').forEach(b => b.classList.toggle('on', b.dataset.tab === tab));
  ['reglages', 'pilote'].forEach(t => $('tab-' + t).classList.toggle('hidden', t !== tab));
  if (tab === 'reglages') renderZones();
}
function closeSheet() { $('sheet').classList.add('hidden'); }
// Les deux boutons en haut à gauche ouvrent leur onglet ; second appui sur le même = fermer
function toggleTab(t) { if (!$('sheet').classList.contains('hidden') && lastTab === t) closeSheet(); else openSheet(t); }
$('btnManeuver').addEventListener('click', () => toggleTab('pilote'));
$('btnZones').addEventListener('click', () => toggleTab('reglages'));
$('btnClose').addEventListener('click', closeSheet);
document.querySelectorAll('.tabs [data-tab]').forEach(b => b.addEventListener('click', () => openSheet(b.dataset.tab)));

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
    li.className = z.id === current.id ? 'cur' : ''; li.dataset.id = z.id;
    li.innerHTML = `<span class="zhandle" title="Glisser pour réordonner">≡</span><span class="zn">${esc(z.name)}</span>`;
    // Appui sur le nom = ouvrir la zone (carte centrée et cadrée comme ⤢)
    li.querySelector('.zn').onclick = () => loadZone(z.id);
    const off = document.createElement('span'); off.className = 'zoff';
    if (dlProgress[z.id]) off.innerHTML = `<small>⬇︎ ${dlProgress[z.id]}</small>`;
    else if (z.offline) {
      off.innerHTML = `<small>hors-ligne</small>`;
      const rm = document.createElement('button'); rm.className = 'zoffdel'; rm.textContent = '🗑'; rm.title = 'Supprimer les photos hors-ligne';
      rm.onclick = e => { e.stopPropagation(); removeOffline(z.id); };
      off.append(rm);
    } else if (z.gateA && z.gateB) {
      const dl = document.createElement('button'); dl.className = 'zoffdel'; dl.textContent = '⬇︎ hors-ligne'; dl.title = 'Télécharger les photos pour le hors-ligne';
      dl.onclick = e => { e.stopPropagation(); downloadOffline(z.id); };
      off.append(dl);
    }
    li.querySelector('.zn').append(off);
    const ren = document.createElement('button'); ren.textContent = '✎'; ren.onclick = async () => {
      const n = await ask('Nouveau nom :', z.name); if (!n) return;
      z.name = n; if (current.id === z.id) current.name = n; store.set('psv.zones', zones); persist(); fillInputs(); renderZones();
    };
    const del = document.createElement('button'); del.textContent = '🗑'; del.onclick = async () => {
      if (!(await ask(`Supprimer « ${z.name} » ?`))) return;
      zones = zones.filter(x => x.id !== z.id); store.set('psv.zones', zones); if ((typeof Photo !== 'undefined')) Photo.remove(z.id);
      if (current.id === z.id) { // la zone affichée disparaît : carte vide, au même endroit
        current = newZone(map.getCenter()); applyProfile(current); current.zoom = map.getZoom();
        resetGateMarkers(); placing = null; persist(); fillInputs(); redraw();
      }
      renderZones();
    };
    li.append(ren, del); ul.append(li);
    zoneReorder(li, li.querySelector('.zhandle'));
  });
}
// Réordonner les zones : on tient la poignée ≡ et on glisse la ligne vers le haut ou le bas
function zoneReorder(li, handle) {
  let y0 = 0, dy = 0, active = false;
  handle.addEventListener('pointerdown', e => {
    e.preventDefault(); active = true; y0 = e.clientY; dy = 0;
    try { handle.setPointerCapture(e.pointerId); } catch (er) {}
    li.classList.add('zdrag');
  });
  handle.addEventListener('pointermove', e => {
    if (!active) return;
    dy = e.clientY - y0; li.style.transform = `translateY(${dy}px)`;
    const ul = li.parentNode, rows = [...ul.children].filter(x => x !== li && x.dataset.id);
    const yMid = li.getBoundingClientRect().top + li.offsetHeight / 2;
    const before = rows.find(r => { const b = r.getBoundingClientRect(); return yMid < b.top + b.height / 2; });
    const nextSib = before || null;
    if (li.nextSibling !== nextSib) { // la ligne change de place : on recale le point de départ pour qu'elle reste sous le doigt
      const top0 = li.getBoundingClientRect().top - dy;
      ul.insertBefore(li, nextSib);
      li.style.transform = ''; const top1 = li.getBoundingClientRect().top;
      y0 += top1 - top0; dy = e.clientY - y0; li.style.transform = `translateY(${dy}px)`;
    }
  });
  const end = () => {
    if (!active) return; active = false;
    li.classList.remove('zdrag'); li.style.transform = '';
    const order = [...li.parentNode.children].map(x => x.dataset.id).filter(Boolean);
    zones.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
    store.set('psv.zones', zones);
  };
  handle.addEventListener('pointerup', end); handle.addEventListener('pointercancel', end);
}
function loadZone(id) {
  const z = zones.find(x => x.id === id); if (!z) return;
  current = upgrade(clone(z)); applyProfile(current);
  resetGateMarkers(); placing = null; setBanner(null);
  map.setBearing(current.bearing || 0);
  map.setView([current.center.lat, current.center.lng], Math.max(current.zoom || 17, 15));
  closeSheet(); fillInputs(); redraw(); if (hasGates()) fitFigure(); persist();
}
// Nouvelle zone : on choisit d'abord où aller (ma position ou recherche), puis on place les portes
async function startNewZone(center, zoom) {
  $('nzDlg').classList.add('hidden');
  const n = await ask('Nom de la nouvelle zone (ex. Bouloc) :', ''); if (!n) return;
  current = newZone(center); applyProfile(current); current.zoom = zoom || 17;
  current.name = n; current.id = 'z' + Date.now(); current.updated = Date.now();
  zones.push(clone(current)); store.set('psv.zones', zones);
  resetGateMarkers(); stopMeasure();
  map.setView([center.lat, center.lng], current.zoom);
  placing = 'A'; fillInputs(); persist(); redraw(); closeSheet();
  toast(`« ${n} » créée : place tes portes (onglet Zones pour une porte unique)`);
}
$('btnNewZone').addEventListener('click', () => { $('searchResults').innerHTML = ''; $('nzDlg').classList.remove('hidden'); });
$('nzCancel').addEventListener('click', () => $('nzDlg').classList.add('hidden'));
$('nzMap').addEventListener('click', () => { const c = map.getCenter(); startNewZone({ lat: c.lat, lng: c.lng }, map.getZoom()); });
$('nzHere').addEventListener('click', () => {
  if (!navigator.geolocation) return toast('Géolocalisation indisponible');
  $('nzHere').textContent = '📍 Recherche de ta position…';
  navigator.geolocation.getCurrentPosition(pos => {
    $('nzHere').textContent = '📍 Ma position';
    startNewZone({ lat: pos.coords.latitude, lng: pos.coords.longitude }, 17);
  }, () => { $('nzHere').textContent = '📍 Ma position'; toast('Position refusée ou indisponible'); }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 });
});

// ---------- Recherche ----------
function parseCoords(s) {
  const d = s.replace(/,/g, ' ').trim().split(/\s+/);
  if (d.length === 2 && d.every(x => /^-?\d+(\.\d+)?$/.test(x))) {
    const lat = +d[0], lng = +d[1]; if (Math.abs(lat) <= 90 && Math.abs(lng) <= 180) return { lat, lng };
  }
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
  if (c) { startNewZone(c, 17); return; }
  ul.innerHTML = '<li class="mut">Recherche…</li>';
  try {
    const r = await fetch('https://nominatim.openstreetmap.org/search?format=json&limit=8&accept-language=fr&q=' + encodeURIComponent(q));
    const js = await r.json(); ul.innerHTML = '';
    if (!js.length) ul.innerHTML = '<li class="mut">Rien trouvé.</li>';
    js.forEach(x => {
      const li = document.createElement('li'); const b = document.createElement('button');
      b.className = 'res'; b.textContent = x.display_name;
      b.onclick = () => startNewZone({ lat: +x.lat, lng: +x.lon }, 16);
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
  }, () => { if (center) toast('Position refusée ou indisponible'); }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 });
}
$('btnLocate').addEventListener('click', () => locate(true));
// Boussole : nord en haut. Bouton « Axe » : branche d'approche vers le haut (sens de vol vers le setup) ;
// si les deux branches ont des caps différents, chaque appui passe à l'autre.
// leaflet-rotate : setBearing(b) tourne la carte de +b, donc le cap h est en haut avec b = -h.
const normB = x => ((x % 360) + 360) % 360, diffB = (x, y) => Math.abs(((x - y + 540) % 360) - 180);
function setMapBearing(b, msg) { map.setBearing(b); current.bearing = b; syncCompass(); persist(); if (msg) toast(msg); }
$('btnNorth').addEventListener('click', () => setMapBearing(0, 'Nord en haut'));
$('btnAxisUp').addEventListener('click', () => {
  const targets = [];
  configs().forEach(c => {
    const b = normB(-c.geo.legHeading), m = `Étape de base ${cfgName(c)} vers le haut`;
    const same = targets.find(t => diffB(t.b, b) < 3);
    if (same) same.msg += ' · ' + m; else targets.push({ b, msg: m });
  });
  if (!targets.length) return toast('Place d\'abord les portes');
  const i = targets.findIndex(t => diffB(t.b, normB(map.getBearing())) < 2);
  const next = targets[(i + 1) % targets.length]; // pas encore orienté (i = -1) → 1re branche
  setMapBearing(next.b, next.msg);
});
$('btnFit').addEventListener('click', () => { if (hasGates()) fitFigure(); else toast('Place d\'abord les portes'); });

// ---------- Images satellite (cache commun carte / hors-ligne / PDF) ----------
const tileUrl = (z, x, y, src) => BASEMAPS[src || basemap].url.replace('{z}', z).replace('{x}', x).replace('{y}', y);
async function getTileBlob(url) {
  // Réponse lisible (CORS) obligatoire pour pouvoir dessiner l'image dans le PDF
  if ('caches' in window) {
    try {
      const c = await caches.open(TILE_CACHE); const hit = await c.match(url);
      if (hit && hit.type !== 'opaque') return await hit.blob();
      const r = await fetch(url, { mode: 'cors' });
      if (r.ok) { c.put(url, r.clone()).catch(() => {}); return await r.blob(); }
    } catch (e) { /* on tente sans cache */ }
  }
  const r = await fetch(url, { mode: 'cors' }); if (!r.ok) throw new Error('tuile'); return r.blob();
}
function tilesAround(center, radiusM, zmin, zmax, src) {
  const list = [];
  for (let z = zmin; z <= zmax; z++) {
    const n = Math.pow(2, z);
    const xt = lng => Math.floor((lng + 180) / 360 * n);
    const yt = lat => { const r = lat * Math.PI / 180; return Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * n); };
    const nw = Geo.fromLocal(center, { x: -radiusM, y: radiusM }), se = Geo.fromLocal(center, { x: radiusM, y: -radiusM });
    for (let x = xt(nw.lng); x <= xt(se.lng); x++) for (let y = yt(nw.lat); y <= yt(se.lat); y++) list.push(tileUrl(z, x, y, src));
  }
  return list;
}
// Photos gardées hors-ligne pour une zone : autour du milieu du couloir (700 m en détail, 2,5 km en large)
function offlineTiles(z, src) {
  const center = z.gateA && z.gateB ? { lat: (z.gateA.lat + z.gateB.lat) / 2, lng: (z.gateA.lng + z.gateB.lng) / 2 } : z.center;
  return [...new Set(tilesAround(center, 700, 12, 19, src).concat(tilesAround(center, 2500, 12, 16, src)))];
}
// Retirer le hors-ligne d'une zone : on efface ses photos, sauf celles qui servent à une autre zone gardée hors-ligne
async function removeOffline(id) {
  const z = id === current.id ? current : zones.find(x => x.id === id); if (!z) return;
  if (!(await ask(`Supprimer les photos hors-ligne de « ${z.name} » ? La zone reste enregistrée, la carte ne s'affichera plus qu'avec du réseau.`))) return;
  const keep = new Set();
  zones.filter(x => x.id !== id && x.offline).forEach(x => Object.keys(BASEMAPS).forEach(b => offlineTiles(x, b).forEach(u => keep.add(u))));
  let n = 0;
  if ('caches' in window) {
    const c = await caches.open(TILE_CACHE);
    for (const b of Object.keys(BASEMAPS)) for (const u of offlineTiles(z, b)) if (!keep.has(u) && await c.delete(u)) n++;
  }
  z.offline = null;
  const i = zones.findIndex(x => x.id === id); if (i >= 0) zones[i].offline = null;
  if (current.id === id) current.offline = null;
  store.set('psv.zones', zones); persist(); renderZones();
  toast(`Photos hors-ligne supprimées (${n})`);
}
const dlProgress = {}; // id de zone → « 120/1193 » pendant le téléchargement
async function downloadOffline(id) {
  if (!('caches' in window)) { toast('Hors-ligne non pris en charge ici'); return; }
  if (dlProgress[id]) return;
  const z = id === current.id ? current : zones.find(x => x.id === id); if (!z || !z.gateA || !z.gateB) return;
  const uniq = offlineTiles(z), total = uniq.length;
  if (!(await ask(`Télécharger les photos de « ${z.name} » pour le hors-ligne : ${total} images, environ ${Math.round(total * 25 / 1024)} Mo ?`))) return;
  let done = 0, fail = 0; dlProgress[id] = `0/${total}`; renderZones();
  const worker = async () => {
    while (uniq.length) {
      const u = uniq.shift();
      try { await getTileBlob(u); } catch (e) { fail++; }
      done++; if (done % 20 === 0) { dlProgress[id] = `${done}/${total}`; renderZones(); }
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  delete dlProgress[id];
  const date = new Date().toLocaleDateString('fr-FR');
  const i = zones.findIndex(x => x.id === id); if (i >= 0) { zones[i].offline = date; store.set('psv.zones', zones); }
  if (current.id === id) { current.offline = date; persist(); }
  renderZones();
  toast(fail ? `« ${z.name} » : ${fail} images manquées, relance plus tard pour compléter` : `« ${z.name} » disponible hors-ligne`);
  if (fail) { if (i >= 0) zones[i].offline = null; if (current.id === id) current.offline = null; store.set('psv.zones', zones); persist(); renderZones(); }
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
}

// ---------- Export PDF ----------
let jsPdfLoading = null;
function loadJsPdf() {
  if (window.jspdf) return Promise.resolve();
  if (!jsPdfLoading) jsPdfLoading = new Promise((res, rej) => {
    const s = document.createElement('script'); s.src = 'vendor/jspdf.umd.min.js'; s.onload = res; s.onerror = rej; document.head.append(s);
  });
  return jsPdfLoading;
}
function dateStamp() { const d = new Date(); return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`; }
function safeName(s) { return s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'zone'; }

// Cap (°) placé en haut de la page : le sens de vol sur la branche d'approche, vers le setup
// (on « monte » vers le setup puis l'axe de poser). 1re configuration affichée.
function pdfUpBearing() {
  const c = configs()[0];
  return c ? c.geo.legHeading : 0;
}

async function renderPdfCanvas() {
  const pts = figurePoints();
  const CRS = L.CRS.EPSG3857;
  const Z0 = 19; // pixels « monde » au zoom 19
  const th = pdfUpBearing() * Math.PI / 180, cosT = Math.cos(th), sinT = Math.sin(th);
  const P = pts.map(p => CRS.latLngToPoint(L.latLng(p.lat, p.lng), Z0));
  const c0 = { x: P.reduce((a, p) => a + p.x, 0) / P.length, y: P.reduce((a, p) => a + p.y, 0) / P.length };
  // Rotation monde → page : le cap « th » pointe vers le haut de la page
  const rot = q => { const dx = q.x - c0.x, dy = q.y - c0.y; return { x: dx * cosT + dy * sinT, y: -dx * sinT + dy * cosT }; };
  const unrot = r => ({ x: c0.x + r.x * cosT - r.y * sinT, y: c0.y + r.x * sinT + r.y * cosT });
  const R = P.map(rot);
  const minX = Math.min(...R.map(p => p.x)), maxX = Math.max(...R.map(p => p.x));
  const minY = Math.min(...R.map(p => p.y)), maxY = Math.max(...R.map(p => p.y));
  const fw = maxX - minX, fh = maxY - minY;
  const landscape = true; // toujours en paysage
  const W = 3508, H = 2480; // A4 paysage à 300 dpi
  const fs = 12, uu = W / 1000, lh = fs * 1.5 * uu; // police et interligne du bandeau
  const band = Math.round((Math.max(5, 2.6 + configs().length) + 2.2) * lh); // bandeau d'informations en bas
  const padX = 0.14, padY = 0.08; // marge latérale plus large pour les libellés
  const availW = W * (1 - 2 * padX), availH = (H - band) * (1 - 2 * padY);
  const s = Math.min(availW / Math.max(fw, 1), availH / Math.max(fh, 1)); // px page par px monde z19
  const cxr = (minX + maxX) / 2, cyr = (minY + maxY) / 2, mapCY = (H - band) / 2;
  const toPage = r => ({ x: W / 2 + (r.x - cxr) * s, y: mapCY + (r.y - cyr) * s });
  const toC = ll => toPage(rot(CRS.latLngToPoint(L.latLng(ll.lat, ll.lng), Z0)));
  const pageAngle = deg => deg * Math.PI / 180 - th; // un cap réel → angle sur la page (0 = haut)

  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const g = cv.getContext('2d');
  g.fillStyle = '#2b2b2b'; g.fillRect(0, 0, W, H);

  // Images satellite : zoom assez fin pour la résolution, au plus 19
  let z = Z0;
  while (z > 1 && s * Math.pow(2, Z0 - z) < 1) z--;
  const f = Math.pow(2, Z0 - z); // 1 px à z = f px à z19
  // Emprise monde des 4 coins de la page (la page est tournée)
  const corners = [[0, 0], [W, 0], [0, H], [W, H]].map(([X, Y]) => unrot({ x: (X - W / 2) / s + cxr, y: (Y - mapCY) / s + cyr }));
  const wx0 = Math.min(...corners.map(p => p.x)) / f, wx1 = Math.max(...corners.map(p => p.x)) / f;
  const wy0 = Math.min(...corners.map(p => p.y)) / f, wy1 = Math.max(...corners.map(p => p.y)) / f;
  const jobs = [];
  let fails = 0;
  for (let tx = Math.floor(wx0 / 256); tx <= Math.floor(wx1 / 256); tx++)
    for (let ty = Math.floor(wy0 / 256); ty <= Math.floor(wy1 / 256); ty++) jobs.push({ tx, ty });
  g.save();
  g.translate(W / 2, mapCY); g.scale(s, s); g.translate(-cxr, -cyr); g.rotate(-th); g.translate(-c0.x, -c0.y);
  const run = async () => {
    while (jobs.length) {
      const { tx, ty } = jobs.shift();
      try {
        const img = await createImageBitmap(await getTileBlob(tileUrl(z, tx, ty)));
        const size = 256 * f;
        g.drawImage(img, tx * size, ty * size, size + 0.5 * f, size + 0.5 * f);
      } catch (e) { fails++; }
    }
  };
  await Promise.all(Array.from({ length: 6 }, run));
  g.restore();
  if ((typeof Photo !== 'undefined')) { try { await Photo.drawPdf(g, toC); } catch (e) {} }

  // ---- Tracé ----
  const u = W / 1000; // unité de taille relative à la page
  const pxPerM = ll => { const a = toC(ll), b = toC(Geo.fromLocal(ll, { x: 100, y: 0 })); return Math.hypot(b.x - a.x, b.y - a.y) / 100; };
  const line = (a, b, color, w, dash) => { g.save(); g.strokeStyle = color; g.lineWidth = w * u; g.setLineDash(dash ? dash.map(d => d * u) : []); g.beginPath(); const A = toC(a), B = toC(b); g.moveTo(A.x, A.y); g.lineTo(B.x, B.y); g.stroke(); g.restore(); };
  const shadowText = (txt, x, y, color, size, align) => {
    g.save(); g.font = `700 ${size * u}px -apple-system, Helvetica, Arial, sans-serif`; g.textBaseline = 'middle';
    const w = g.measureText(txt).width, m = 12 * u;
    if (!align) align = (x + w > W - m) ? 'right' : 'left'; // libellé à gauche du point s'il sortirait de la page
    if (align === 'right' && x - w < m) x = m + w;          // recadrage horizontal dans la page
    if (align === 'left' && x + w > W - m) x = W - m - w;
    if (align === 'center') x = Math.min(Math.max(x, m + w / 2), W - m - w / 2);
    y = Math.min(Math.max(y, 20 * u), H - band - 14 * u);   // jamais sous le bandeau
    g.textAlign = align;
    g.lineWidth = size * u * 0.28; g.strokeStyle = isDark(color) ? 'rgba(255,255,255,.9)' : 'rgba(0,0,0,.85)'; g.lineJoin = 'round'; g.strokeText(txt, x, y); g.fillStyle = color; g.fillText(txt, x, y); g.restore();
  };
  const dot = (ll, color, r, label) => {
    const c = toC(ll); g.save(); g.beginPath(); g.arc(c.x, c.y, r * u, 0, 2 * Math.PI); g.fillStyle = color; g.fill();
    g.lineWidth = 1.2 * u; g.strokeStyle = '#111'; g.stroke(); g.restore();
    if (label && showLabels()) shadowText(label, c.x + (r + 4) * u, c.y, color, 13);
  };
  const chevron = (from, to, frac, color) => chevronW(from, to, frac, color, 3);
  const chevronW = (from, to, frac, color, w) => {
    const A = toC(from), B = toC(to), dx = B.x - A.x, dy = B.y - A.y, n = Math.hypot(dx, dy) || 1, ux = dx / n, uy = dy / n;
    const mx = A.x + dx * frac, my = A.y + dy * frac, L0 = 12 * u;
    g.save(); g.strokeStyle = color; g.lineWidth = w * u; g.beginPath();
    g.moveTo(mx - ux * L0 - uy * L0 * 0.6, my - uy * L0 + ux * L0 * 0.6); g.lineTo(mx, my); g.lineTo(mx - ux * L0 + uy * L0 * 0.6, my - uy * L0 - ux * L0 * 0.6); g.stroke(); g.restore();
  };
  const chevronHalo = (from, to, frac) => { g.save(); g.globalAlpha = .85; chevronW(from, to, frac, '#ffffff', 6); g.restore(); };
  // Portes : segment perpendiculaire à l'axe + un drapeau à chaque bout (comme sur la carte)
  const gateMark = (key, label) => {
    const gl = current['gate' + key], h = headingOf(key) * Math.PI / 180;
    const P = toC(gl), Q = toC(Geo.fromLocal(gl, { x: 10 * Math.sin(h), y: 10 * Math.cos(h) }));
    const dl = Math.hypot(Q.x - P.x, Q.y - P.y) || 1, dx = (Q.x - P.x) / dl, dy = (Q.y - P.y) / dl; // sens du poser sur la page
    const px = -dy, py = dx, W2 = 15 * u;
    g.save(); g.lineCap = 'round';
    g.strokeStyle = 'rgba(0,0,0,.55)'; g.lineWidth = 6 * u; g.beginPath(); g.moveTo(P.x - px * W2, P.y - py * W2); g.lineTo(P.x + px * W2, P.y + py * W2); g.stroke();
    g.strokeStyle = GATE_COLOR; g.lineWidth = 3.5 * u; g.stroke();
    [-1, 1].forEach(sd => {
      const ex = P.x + sd * px * W2, ey = P.y + sd * py * W2; // drapeau debout (vers le haut de la page)
      g.strokeStyle = '#111'; g.lineWidth = 2 * u; g.beginPath(); g.moveTo(ex, ey); g.lineTo(ex, ey - 18 * u); g.stroke();
      g.fillStyle = GATE_COLOR; g.lineWidth = 1.2 * u; g.beginPath(); g.moveTo(ex, ey - 18 * u); g.lineTo(ex + 11 * u, ey - 14 * u); g.lineTo(ex, ey - 10 * u); g.closePath(); g.fill(); g.stroke();
      g.fillStyle = '#fff'; g.beginPath(); g.arc(ex, ey, 2.5 * u, 0, 2 * Math.PI); g.fill(); g.stroke();
    });
    g.restore();
    if (showLabels()) shadowText(label, P.x + 24 * u, P.y, GATE_COLOR, 13);
  };
  const circle = (center, radius, color) => {
    if (!(radius > 0)) return;
    const c = toC(center), R = radius * pxPerM(center), p = current.params;
    g.save(); g.strokeStyle = color; g.lineWidth = 2.6 * u; g.fillStyle = color; g.globalAlpha = .08;
    g.beginPath(); g.arc(c.x, c.y, R, 0, 2 * Math.PI); g.fill(); g.globalAlpha = 1; g.stroke();
    if (p.rings) {
      const v = +p.vref || 5; g.lineWidth = 1 * u; g.setLineDash([3 * u, 5 * u]); g.globalAlpha = .7;
      for (let k = 1; k < v; k++) { g.beginPath(); g.arc(c.x, c.y, R * k / v, 0, 2 * Math.PI); g.stroke(); }
      g.setLineDash([]); g.globalAlpha = 1;
    }
    if (p.ticks !== false) {
      g.lineWidth = 1.6 * u;
      Geo.degTicks(R / u, 40).forEach(deg => { // mêmes graduations que sur la carte, chiffres à l'extérieur
        const a = pageAngle(deg), l = 11 * u;
        g.beginPath(); g.moveTo(c.x + R * Math.sin(a), c.y - R * Math.cos(a)); g.lineTo(c.x + (R - l) * Math.sin(a), c.y - (R - l) * Math.cos(a)); g.stroke();
        shadowText(`${deg}°`, c.x + (R + 16 * u) * Math.sin(a), c.y - (R + 16 * u) * Math.cos(a), color, 12, 'center');
      });
    }
    g.restore();
  };

  if (!current.single && current.show !== 'none') line(current.gateA, current.gateB, AXIS_COLOR, 3.2);
  const cfs = configs();
  cfs.forEach(c => {
    const col = c.colors, p = current.params;
    if (showRec()) line(c.behind, c.gate, AXIS_COLOR, 2, [9, 7]);
    const len = Math.min(25, corridorLength() * 0.3);
    chevron(c.gate, Geo.fromLocal(c.gate, { x: c.geo.f.x * len, y: c.geo.f.y * len }), 1, GATE_COLOR);
    if ((+p.legLen || 0) > 0) {
      line(c.legStart, c.setup, '#ffffff', 6); line(c.legStart, c.setup, col.leg, 3.2);
      chevronHalo(c.legStart, c.setup, 0.55); chevron(c.legStart, c.setup, 0.55, col.leg);
      const S = toC(c.legStart);
      dot(c.legStart, col.leg, 6);
      // Libellé de branche jamais posé sur la branche :
      // branche plutôt verticale → libellé à côté du point ; plutôt horizontale → au-dessus, côté extérieur
      const Sp = toC(c.setup), dx = S.x - Sp.x, dy = S.y - Sp.y, dn = Math.hypot(dx, dy) || 1;
      if (!showLabels()) { /* textes masqués */ } else if (Math.abs(dx / dn) < 0.5) {
        shadowText(legLine1(c), S.x + 12 * u, S.y - 9 * u, col.leg, 13);
        shadowText(legLine2(c), S.x + 12 * u, S.y + 9 * u, col.leg, 11);
      } else {
        const al = dx > 0 ? 'left' : 'right';
        shadowText(legLine1(c), S.x, S.y - 28 * u, col.leg, 13, al);
        shadowText(legLine2(c), S.x, S.y - 12 * u, col.leg, 11, al);
      }
    }
    if (showRec()) line(c.setup, c.rec, '#ffffff', 1, [2, 6]);
    circle(c.setup, c.geo.rSetup, col.setup);
    if (showRec()) circle(c.rec, c.geo.rRec, col.rec);
    dot(c.setup, col.setup, 8, `Setup ${cfgName(c)}`);
    if (showRec()) dot(c.rec, col.rec, 6.5, `Snap ${cfgName(c)}`);
  });
  gateMark('A', `Portes ${cardOf(headingOf('A'))}`);
  if (!current.single) gateMark('B', `Portes ${cardOf(headingOf('B'))}`);

  // ---- Flèche du nord (haut droite) ----
  const nx = 85 * u, ny = 95 * u, na = pageAngle(0); // coin haut gauche (les libellés partent vers la droite)
  g.save(); g.fillStyle = 'rgba(0,0,0,.6)'; g.beginPath(); g.arc(nx, ny, 40 * u, 0, 2 * Math.PI); g.fill();
  g.translate(nx, ny); g.rotate(na);
  g.fillStyle = '#fff'; g.beginPath(); g.moveTo(0, -30 * u); g.lineTo(-12 * u, 12 * u); g.lineTo(0, 4 * u); g.lineTo(12 * u, 12 * u); g.closePath(); g.fill();
  g.restore();
  shadowText('N', nx + Math.sin(na) * 52 * u, ny - Math.cos(na) * 52 * u, '#fff', 13, 'center');

  // ---- Échelle graphique (sur la photo, juste au-dessus du bandeau) ----
  const by = H - band;
  const tx = (s2, x, y, c, size, bold, align) => { g.save(); g.font = `${bold ? 700 : 500} ${(size || fs) * u}px -apple-system, Helvetica, Arial, sans-serif`; g.fillStyle = c || '#eee'; g.textBaseline = 'middle'; g.textAlign = align || 'left'; g.fillText(s2, x, y); g.restore(); };
  const mppC = 1 / pxPerM(current.gateA);
  const target = W * 0.18 * mppC, nice = [5, 10, 20, 25, 50, 100, 200, 250, 500, 1000].reduce((a, b) => (b <= target ? b : a), 5);
  const barW = nice / mppC, sx = 30 * u, sy = by - 28 * u;
  g.save(); g.fillStyle = 'rgba(0,0,0,.55)'; g.fillRect(sx - 10 * u, sy - 16 * u, barW + 90 * u, 32 * u);
  g.fillStyle = '#fff'; g.fillRect(sx, sy - 4 * u, barW, 8 * u); g.fillStyle = '#111'; g.fillRect(sx + barW / 2, sy - 3 * u, barW / 2 - 1 * u, 6 * u); g.restore();
  tx(`${nice} m`, sx + barW + 10 * u, sy, '#fff', 12, true);

  // ---- Bandeau d'informations ----
  g.save(); g.fillStyle = 'rgba(12,12,12,.82)'; g.fillRect(0, by, W, band); g.restore();
  const p = current.params, t = (+p.t1 || 0) + (+p.t2 || 0), r0 = Math.round;
  const col1 = 30 * u, col2 = W * 0.52, l0 = by + lh * 1.1;
  tx(`${current.name}`, col1, l0, '#fff', fs * 1.3, true);
  tx(`${new Date().toLocaleDateString('fr-FR')} · ${current.single ? 'porte unique' : `couloir ${r0(corridorLength())} m`}`, col1, l0 + lh * 1.2, '#bbb');
  let ly = l0 + lh * 2.4;
  cfs.forEach(c => { tx(`${cfgName(c)} : poser au ${hdg(c.heading)}, virage à ${c.turn === 'G' ? 'gauche' : 'droite'}`, col1, ly, c.colors.setup, fs, true); ly += lh; });
  [
    `Abattée + rotation ${p.t1} s · recouvrement ${p.t2} s`,
    `Setup : ${p.setupBack} m arrière · ${p.setupSide} m latéral` + (p.setupHeight != null && p.setupHeight !== '' ? ` · hauteur ${p.setupHeight} m` : ''),
    `Point de snap : ${p.recBack} m arrière`,
    `Étape de base : ${p.legTime} s à ${p.legSpeed} m/s = ${p.legLen} m` + (p.legHeight != null && p.legHeight !== '' ? ` · entrée à ${p.legHeight} m` : ''),
    `Cercles ${p.vref} m/s : setup ${r0(p.vref * t)} m · snap ${r0(p.vref * p.t2)} m`
  ].forEach((s2, i) => tx(s2, col2, l0 + i * lh, '#eee'));
  tx(`${BASEMAPS[basemap].attr} · Setup PSV v${VERSION}`, W - 20 * u, H - 10 * u, '#888', 8, false, 'right');

  return { canvas: cv, landscape, fails };
}

let pdfFile = null;
$('btnPdf').addEventListener('click', async () => {
  if (!hasGates()) return toast('Place d\'abord les deux portes');
  const b = $('btnPdf'); b.disabled = true; const old = b.textContent; b.textContent = 'Préparation du PDF…';
  try {
    await loadJsPdf();
    const { canvas, landscape, fails } = await renderPdfCanvas();
    const doc = new window.jspdf.jsPDF({ orientation: landscape ? 'landscape' : 'portrait', unit: 'mm', format: 'a4' });
    const wmm = landscape ? 297 : 210, hmm = landscape ? 210 : 297;
    doc.addImage(canvas.toDataURL('image/jpeg', 0.88), 'JPEG', 0, 0, wmm, hmm);
    const name = `${dateStamp()}_Setup_PSV_${safeName(current.name)}.pdf`;
    pdfFile = new File([doc.output('blob')], name, { type: 'application/pdf' });
    $('pdfName').textContent = name + (fails ? ` (${fails} morceaux de photo manquants)` : '');
    $('pdfReady').classList.remove('hidden');
  } catch (e) {
    console.error(e); toast('Échec du PDF : ' + (e && e.message ? e.message : 'erreur'));
  } finally { b.disabled = false; b.textContent = old; }
});
$('pdfClose').addEventListener('click', () => $('pdfReady').classList.add('hidden'));
$('pdfShare').addEventListener('click', async () => {
  if (!pdfFile) return;
  try {
    if (navigator.canShare && navigator.canShare({ files: [pdfFile] })) { await navigator.share({ files: [pdfFile] }); /* sans title : iOS en ferait un .txt en plus */ }
    else { const url = URL.createObjectURL(pdfFile); const a = document.createElement('a'); a.href = url; a.download = pdfFile.name; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 60000); }
    $('pdfReady').classList.add('hidden');
  } catch (e) { if (e && e.name !== 'AbortError') toast('Partage impossible'); }
});

// ---------- Sauvegarde ----------
// Exporter : fichier .json (zones + manœuvre) proposé à la feuille de partage (Fichiers, AirDrop, mail…).
$('btnExport').addEventListener('click', async () => {
  persist();
  const data = JSON.stringify({ app: 'setup-psv', v: 3, exported: new Date().toISOString(), profile, zones }, null, 1);
  const name = `${dateStamp()}_Setup_PSV_zones.json`;
  const file = new File([data], name, { type: 'application/json' });
  try {
    if (navigator.canShare && navigator.canShare({ files: [file] })) await navigator.share({ files: [file] }); /* sans title : iOS en ferait un .txt en plus */
    else { const url = URL.createObjectURL(file); const a = document.createElement('a'); a.href = url; a.download = name; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 60000); }
  } catch (e) { if (e && e.name !== 'AbortError') toast('Export impossible'); }
});
// Importer : ajoute les zones du fichier à celles déjà là (fusion, rien n'est effacé).
// Même zone des deux côtés → on garde la version la plus récente. Si l'appli est vide, on reprend aussi la manœuvre du fichier.
$('btnImport').addEventListener('click', () => { $('importFile').value = ''; $('importFile').click(); });
$('importFile').addEventListener('change', async e => {
  const f = e.target.files && e.target.files[0]; if (!f) return;
  try {
    const d = JSON.parse(await f.text());
    if (!Array.isArray(d.zones)) throw new Error('format');
    const wasEmpty = zones.length === 0;
    if (wasEmpty && d.profile) { PROFILE_KEYS.forEach(k => { if (d.profile[k] !== undefined) profile[k] = d.profile[k]; }); profile.legLen = legLenOf(profile); store.set('psv.profile', profile); }
    let added = 0, updated = 0;
    d.zones.map(upgrade).forEach(z => {
      if (!z.id) z.id = 'z' + Date.now() + Math.random().toString(36).slice(2, 6);
      applyProfile(z);
      const i = zones.findIndex(x => x.id === z.id);
      if (i < 0) { zones.push(z); added++; }
      else if ((z.updated || 0) > (zones[i].updated || 0)) { zones[i] = z; updated++; }
    });
    store.set('psv.zones', zones);
    if (wasEmpty) { applyProfile(current); fillInputs(); }
    renderZones(); redraw();
    toast(`Import : ${added} zone(s) ajoutée(s)${updated ? `, ${updated} mise(s) à jour` : ''}`);
  } catch (er) { toast('Fichier illisible'); }
});
// Tout effacer (zones, manœuvre, zone en cours) — les photos gardées hors-ligne restent.
$('btnWipe').addEventListener('click', async () => {
  if (!(await ask('Effacer TOUTES les données (zones enregistrées, manœuvre, zone en cours) ? C\'est définitif. Pense à exporter avant si besoin.'))) return;
  ['psv.zones', 'psv.current', 'psv.profile', 'psv.lastParams'].forEach(k => { try { localStorage.removeItem(k); } catch (er) {} });
  if ((typeof Photo !== 'undefined')) await Photo.clearAll();
  location.reload();
});

function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

// ---------- Démarrage ----------
$('ver').textContent = VERSION;
syncCompass();
fillInputs();
if (hasGates()) fitFigure();
redraw();
if (!current.gateA && !current.id && current.zoom < 10) locate(true); else locate(false);
// Mise à jour automatique : vérifie une nouvelle version à chaque retour sur l'appli et recharge dès qu'elle est installée
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  const hadController = !!navigator.serviceWorker.controller;
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (hadController && !reloading) { reloading = true; location.reload(); } });
  navigator.serviceWorker.register('sw.js').then(reg => {
    document.addEventListener('visibilitychange', () => { if (!document.hidden) reg.update().catch(() => {}); });
  }).catch(() => {});
}
