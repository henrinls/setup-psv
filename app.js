'use strict';
// Filet de sécurité : toute erreur s'affiche au lieu de laisser une carte vide
window.addEventListener('error', e => {
  const t = document.getElementById('toast');
  if (t) { t.textContent = 'Erreur : ' + (e.message || 'inconnue') + ' — ferme et rouvre l\'appli'; t.classList.remove('hidden'); }
});
const VERSION = '2.7.2';
const TILE_URL = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
const TILE_CACHE = 'psv-tiles-v2';
const DEFAULT_PARAMS = {
  t1: 10, t2: 4, setupBack: 100, setupSide: 60, recBack: 30,
  vref: 5, legLen: 150, legTime: 10, legHeight: 300, rings: true, ticks: true, labels: true, rec: true
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
  z.turnA = z.turnA || 'G'; z.turnB = z.turnB || 'G'; z.show = z.show || 'AB';
  return z;
}
let zones = store.get('psv.zones', []).map(upgrade);
let current = upgrade(store.get('psv.current', null)) || newZone(null);
store.set('psv.zones', zones);

function newZone(center) {
  return upgrade({
    id: null, name: 'Nouvelle zone',
    center: center || { lat: 46.6, lng: 2.4 }, zoom: center ? 17 : 6,
    gateA: null, gateB: null, turnA: 'G', turnB: 'G', show: 'AB',
    params: Object.assign({}, DEFAULT_PARAMS, store.get('psv.lastParams', {}))
  });
}
function persist() {
  current.center = map.getCenter(); current.zoom = map.getZoom();
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
function cfgName(c) { return `${hdg(c.heading)} ${c.turn}`; }
function cfgNameKey(key) { return hasGates() ? `${hdg(headingOf(key))} ${current['turn' + key]}` : (key === 'A' ? '1re porte' : '2e porte'); }
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
  if (current.show !== 'B') out.push({ key: 'A', gate: current.gateA, heading: hA, turn: current.turnA });
  if (current.show !== 'A') out.push({ key: 'B', gate: current.gateB, heading: hB, turn: current.turnB });
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
L.tileLayer(TILE_URL, {
  maxNativeZoom: 19, maxZoom: 22, crossOrigin: 'anonymous',
  attribution: 'Imagerie © Esri, Maxar, Earthstar Geographics'
}).addTo(map);
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
  updateLegend(); updateAxisInfo(); syncQuick();
  if (!hasGates()) {
    if (!placing) placing = current.gateA ? 'B' : 'A';
    setBanner(placing === 'A' ? 'Touche la carte au début du couloir (1re porte).' : 'Touche maintenant l\'autre bout du couloir (2e porte).');
    syncPlaceBtn();
    if (current.gateA) placeGateMarkers();
    return;
  }
  if (!placing) setBanner(null);
  const p = current.params;

  // Couloir A–B + prolongements derrière chaque porte jusqu'au point de snap
  L.polyline([LL(current.gateA), LL(current.gateB)], { color: AXIS_COLOR, weight: 3, opacity: .95, interactive: false }).addTo(fig);
  configs().forEach(c => {
    const col = c.colors;
    if (showRec()) L.polyline([LL(c.behind), LL(c.gate)], { color: AXIS_COLOR, weight: 2, dashArray: '8 6', opacity: .9, interactive: false }).addTo(fig);
    // Flèche du sens du poser depuis cette porte
    const other = c.key === 'A' ? current.gateB : current.gateA;
    const len = Math.min(25, corridorLength() * 0.3);
    const tip = Geo.fromLocal(c.gate, { x: c.geo.f.x * len, y: c.geo.f.y * len });
    L.polyline(arrowAt(c.gate, tip, 1, Math.max(len * 0.3, 4)), { color: GATE_COLOR, weight: 3, interactive: false }).addTo(fig);
    void other;

    // Branche d'approche
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

function legLine1(c) { const p = current.params; return `Branche ${cfgName(c)} · ${p.legLen} m` + (+p.legTime ? ` · ${p.legTime} s` : ''); }
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
  const st = Geo.tickSteps(radius / mpp);
  const pt = (deg, d) => { const a = deg * Math.PI / 180; return LL(Geo.fromLocal(center, { x: d * Math.sin(a), y: d * Math.cos(a) })); };
  if (!st) { L.polyline([pt(0, radius), pt(0, radius - 8 * mpp)], { color, weight: 2, interactive: false }).addTo(grads); return; }
  const segs = [];
  for (let deg = 0; deg < 360; deg += (st.minor || st.label)) {
    const major = deg % st.label === 0;
    segs.push([pt(deg, radius), pt(deg, radius - (major ? 11 : 6) * mpp)]);
    if (major && showLabels()) {
      const card = { 0: ' N', 90: ' E', 180: ' S', 270: ' O' }[deg] || '';
      L.marker(pt(deg, radius + 13 * mpp), { interactive: false,
        icon: L.divIcon({ className: 'glabel', html: `<span style="color:${color}">${deg}°${card}</span>`, iconSize: [0, 0] }) }).addTo(grads);
    }
  }
  L.polyline(segs, { color, weight: 1.5, interactive: false }).addTo(grads);
}

const isDragging = m => !!(m && m.dragging && m.dragging._draggable && m.dragging._draggable._moving);
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
  return L.divIcon({ className: 'gate', iconSize: [60, 60], iconAnchor: [30, 30],
    html: `<svg class="gsvg" width="60" height="60" viewBox="-30 -30 60 60"></svg>${label ? `<b style="color:${GATE_COLOR}">${label}</b>` : ''}` });
}
function rotateGateIcons() {
  const b = map.getBearing ? map.getBearing() : 0;
  [['A', markerA], ['B', markerB]].forEach(([k, m]) => {
    const el = m && m.getElement && m.getElement(); if (!el) return;
    const svg = el.querySelector('.gsvg'); if (!svg) return;
    svg.innerHTML = gateSvg((hasGates() ? headingOf(k) : 0) + b);
  });
}
function gateLabel(key) { return showLabels() && hasGates() ? `Portes ${hdg(headingOf(key))}` : ''; }
function makeGateMarker(key) {
  const m = L.marker(LL(current['gate' + key]), { draggable: true, icon: gateIcon(gateLabel(key)), zIndexOffset: 1000 }).addTo(map);
  m._psvLabel = gateLabel(key);
  m.on('drag', e => { current['gate' + key] = { lat: e.latlng.lat, lng: e.latlng.lng }; drawLight(); });
  m.on('dragend', () => { persist(); redraw(); });
  return m;
}
function syncGate(m, key) {
  if (isDragging(markerA) || isDragging(markerB)) return; // ne jamais toucher une porte pendant un glissement
  m.setLatLng(LL(current['gate' + key]));
  const lab = gateLabel(key);
  if (m._psvLabel !== lab) { m.setIcon(gateIcon(lab)); m._psvLabel = lab; }
}
function placeGateMarkers() {
  if (current.gateA) { if (!markerA) markerA = makeGateMarker('A'); else syncGate(markerA, 'A'); }
  if (current.gateB) { if (!markerB) markerB = makeGateMarker('B'); else syncGate(markerB, 'B'); }
  rotateGateIcons();
}
function resetGateMarkers() {
  [markerA, markerB].forEach(m => m && map.removeLayer(m));
  markerA = markerB = null;
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
  $('axisInfo').textContent = hasGates()
    ? `Axes de poser : ${hdg(axisHeading())} et ${hdg((axisHeading() + 180) % 360)} · couloir ${Math.round(corridorLength())} m`
    : 'Portes pas encore placées.';
}

// ---------- Interface ----------
// Élément absent (ex. page en cache d'une version plus ancienne) : on renvoie un élément fantôme
// plutôt que de planter toute l'appli.
function $(id) { return document.getElementById(id) || document.createElement('div'); }
function setBanner(t) { const b = $('banner'); if (!t) b.classList.add('hidden'); else { b.textContent = t; b.classList.remove('hidden'); } }
let toastT;
function toast(t) { const el = $('toast'); el.textContent = t; el.classList.remove('hidden'); clearTimeout(toastT); toastT = setTimeout(() => el.classList.add('hidden'), 2800); }

const numFields = ['t1', 't2', 'setupBack', 'setupSide', 'recBack', 'vref', 'legLen', 'legTime', 'legHeight'];
function fillInputs(only) {
  const p = current.params;
  (only || numFields).forEach(k => { const el = $('p_' + k); if (el && document.activeElement !== el) el.value = p[k]; });
  if (only) return;
  syncQuick();
  $('zoneName').textContent = current.name + (current.id ? '' : ' (non enregistrée)');
}
numFields.forEach(k => {
  $('p_' + k).addEventListener('input', e => {
    const v = parseFloat(String(e.target.value).replace(',', '.'));
    if (isNaN(v)) return;
    current.params[k] = v; persist(); redraw();
  });
  $('p_' + k).addEventListener('blur', () => fillInputs([k]));
});
// ---------- Bascules rapides sur la carte ----------
function syncQuick() {
  const p = current.params, sh = current.show;
  const h = k => hasGates() ? hdg(headingOf(k)) : (k === 'A' ? '1re' : '2e');
  const t = k => `${h(k)} ${current['turn' + k] === 'G' ? '↺ G' : '↻ D'}`;
  $('qTurnA').textContent = t('A'); $('qTurnB').textContent = t('B');
  $('qShowA').classList.toggle('on', sh !== 'B'); $('qShowB').classList.toggle('on', sh !== 'A');
  $('qShowA').textContent = '👁 ' + h('A'); $('qShowB').textContent = '👁 ' + h('B');
  $('qRec').classList.toggle('on', showRec());
  $('qTicks').classList.toggle('on', p.ticks !== false); $('qRings').classList.toggle('on', !!p.rings);
}
function quick(fn, msg) { fn(); syncQuick(); persist(); redraw(); if (msg) toast(msg()); }
$('qTurnA').addEventListener('click', () => quick(() => { current.turnA = current.turnA === 'G' ? 'D' : 'G'; }, () => `${cfgNameKey('A')} : virage à ${current.turnA === 'G' ? 'gauche' : 'droite'}`));
$('qTurnB').addEventListener('click', () => quick(() => { current.turnB = current.turnB === 'G' ? 'D' : 'G'; }, () => `${cfgNameKey('B')} : virage à ${current.turnB === 'G' ? 'gauche' : 'droite'}`));
function toggleShow(k) {
  const vis = { A: current.show !== 'B', B: current.show !== 'A' };
  vis[k] = !vis[k];
  if (!vis.A && !vis.B) { toast('Il faut au moins une porte affichée'); return; }
  quick(() => { current.show = vis.A && vis.B ? 'AB' : (vis.A ? 'A' : 'B'); });
}
$('qShowA').addEventListener('click', () => toggleShow('A'));
$('qShowB').addEventListener('click', () => toggleShow('B'));
$('qTicks').addEventListener('click', () => quick(() => { current.params.ticks = current.params.ticks === false; }, () => current.params.ticks ? 'Graduations affichées' : 'Graduations masquées'));
$('qRec').addEventListener('click', () => quick(() => { current.params.rec = !showRec(); }, () => showRec() ? 'Point de snap affiché' : 'Point de snap masqué'));
$('qRings').addEventListener('click', () => quick(() => { current.params.rings = !current.params.rings; }, () => current.params.rings ? 'Anneaux 1 m/s affichés' : 'Anneaux 1 m/s masqués'));
document.querySelectorAll('[data-rot]').forEach(b => b.addEventListener('click', () => {
  if (!hasGates()) return toast('Place d\'abord les deux portes');
  const v = Geo.toLocal(current.gateA, current.gateB), d = Math.hypot(v.x, v.y);
  const h = (axisHeading() + +b.dataset.rot) * Math.PI / 180;
  current.gateB = Geo.fromLocal(current.gateA, { x: d * Math.sin(h), y: d * Math.cos(h) });
  persist(); redraw();
}));

function syncPlaceBtn() { $('btnPlaceGates').classList.toggle('on', !!placing); }
$('btnPlaceGates').addEventListener('click', () => {
  if (placing && hasGates()) { placing = null; setBanner(null); syncPlaceBtn(); return; }
  stopMeasure(); placing = 'A'; syncPlaceBtn(); setBanner('Touche la carte au début du couloir (1re porte).'); closeSheet();
});
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
  const m = L.marker(LL(meas[key]), { draggable: true, icon: measIcon, zIndexOffset: 900 }).addTo(measLayer);
  m.on('drag', e => { meas[key] = { lat: e.latlng.lat, lng: e.latlng.lng }; updateMeasure(); });
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
  measBox(`<b>Cap ${hdg(c)} · ${fmtDist(d)}</b><br><small>Fais glisser les points pour ajuster · 📏 = effacer</small>`);
}
function measureClick(p) {
  if (!meas.a) { meas.a = p; meas.ma = measMarker('a'); measBox('Mesure : touche le <b>2e point</b>'); return; }
  if (!meas.b) { meas.b = p; meas.mb = measMarker('b'); updateMeasure(); }
  // une fois les deux points posés, on les déplace au doigt ; un appui sur la carte ne fait rien
}
map.on('click', e => {
  if (!placing && meas.active) { measureClick({ lat: e.latlng.lat, lng: e.latlng.lng }); return; }
  if (!placing) return;
  const p = { lat: e.latlng.lat, lng: e.latlng.lng };
  if (placing === 'A') {
    current.gateA = p; placing = 'B';
    if (markerA) markerA.setLatLng(LL(p));
    setBanner('Touche maintenant l\'autre bout du couloir (2e porte).');
    if (markerB) { map.removeLayer(markerB); markerB = null; } current.gateB = null;
  } else {
    current.gateB = p; placing = null; setBanner(null);
    toast('Portes placées. Fais-les glisser pour ajuster.');
  }
  syncPlaceBtn(); persist(); redraw();
});
map.on('zoomend', redraw);

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
  current = upgrade(clone(z));
  resetGateMarkers(); placing = null; setBanner(null);
  map.setBearing(current.bearing || 0);
  map.setView([current.center.lat, current.center.lng], Math.max(current.zoom || 17, 15));
  fillInputs(); if (hasGates()) fitFigure(); persist(); redraw(); closeSheet();
}
$('btnSaveZone').addEventListener('click', async () => {
  const n = await ask('Nom de la zone (ex. Bouloc – couloir swoop) :', current.id ? current.name : ''); if (!n) return;
  current.name = n;
  if (!current.id) { current.id = 'z' + Date.now(); zones.push(clone(current)); }
  store.set('psv.zones', zones); persist(); fillInputs(); renderZones(); toast('Zone enregistrée');
});
$('btnNewZone').addEventListener('click', async () => {
  if (!(await ask('Créer une nouvelle zone au centre de la carte ? (les réglages de virage sont repris)'))) return;
  const params = Object.assign({}, current.params);
  current = newZone(map.getCenter()); current.params = params; current.zoom = map.getZoom();
  resetGateMarkers(); placing = 'A'; fillInputs(); persist(); redraw(); closeSheet();
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
    const b = normB(-c.geo.legHeading), m = `Branche ${cfgName(c)} vers le haut`;
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
const tileUrl = (z, x, y) => TILE_URL.replace('{z}', z).replace('{x}', x).replace('{y}', y);
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
function tilesAround(center, radiusM, zmin, zmax) {
  const list = [];
  for (let z = zmin; z <= zmax; z++) {
    const n = Math.pow(2, z);
    const xt = lng => Math.floor((lng + 180) / 360 * n);
    const yt = lat => { const r = lat * Math.PI / 180; return Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * n); };
    const nw = Geo.fromLocal(center, { x: -radiusM, y: radiusM }), se = Geo.fromLocal(center, { x: radiusM, y: -radiusM });
    for (let x = xt(nw.lng); x <= xt(se.lng); x++) for (let y = yt(nw.lat); y <= yt(se.lat); y++) list.push(tileUrl(z, x, y));
  }
  return list;
}
$('btnOffline').addEventListener('click', async () => {
  if (!('caches' in window)) { toast('Hors-ligne non pris en charge ici'); return; }
  const center = hasGates()
    ? { lat: (current.gateA.lat + current.gateB.lat) / 2, lng: (current.gateA.lng + current.gateB.lng) / 2 }
    : map.getCenter();
  const uniq = [...new Set(tilesAround(center, 700, 12, 19).concat(tilesAround(center, 2500, 12, 16)))];
  if (!(await ask(`Télécharger ${uniq.length} images (environ ${Math.round(uniq.length * 25 / 1024)} Mo) autour ${hasGates() ? 'du couloir' : 'du centre de la carte'} ?`))) return;
  let done = 0, fail = 0; const st = $('offlineStatus'), total = uniq.length;
  const worker = async () => {
    while (uniq.length) {
      const u = uniq.shift();
      try { await getTileBlob(u); } catch (e) { fail++; }
      done++; if (done % 10 === 0) st.textContent = `Téléchargement… ${done}/${total}`;
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  current.offline = new Date().toLocaleDateString('fr-FR'); persist();
  st.textContent = fail ? `Terminé avec ${fail} échecs (relance pour compléter).` : `Zone disponible hors-ligne (${done} images).`;
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
});

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
      const st = Geo.tickSteps(R / (u * 1.4)) || { label: 90, minor: null };
      g.lineWidth = 1.4 * u;
      for (let deg = 0; deg < 360; deg += (st.minor || st.label)) {
        const major = deg % st.label === 0, a = pageAngle(deg), l = (major ? 12 : 6) * u;
        g.beginPath(); g.moveTo(c.x + R * Math.sin(a), c.y - R * Math.cos(a)); g.lineTo(c.x + (R - l) * Math.sin(a), c.y - (R - l) * Math.cos(a)); g.stroke();
        if (major && showLabels()) {
          const card = { 0: ' N', 90: ' E', 180: ' S', 270: ' O' }[deg] || '';
          shadowText(`${deg}°${card}`, c.x + (R + 14 * u) * Math.sin(a), c.y - (R + 14 * u) * Math.cos(a), color, 11, 'center');
        }
      }
    }
    g.restore();
  };

  line(current.gateA, current.gateB, AXIS_COLOR, 3.2);
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
  gateMark('A', `Portes ${hdg(headingOf('A'))}`);
  gateMark('B', `Portes ${hdg(headingOf('B'))}`);

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
  tx(`${new Date().toLocaleDateString('fr-FR')} · couloir ${r0(corridorLength())} m`, col1, l0 + lh * 1.2, '#bbb');
  let ly = l0 + lh * 2.4;
  cfs.forEach(c => { tx(`${cfgName(c)} : poser au ${hdg(c.heading)}, virage à ${c.turn === 'G' ? 'gauche' : 'droite'}`, col1, ly, c.colors.setup, fs, true); ly += lh; });
  [
    `Abattée + rotation ${p.t1} s · recouvrement ${p.t2} s`,
    `Setup : ${p.setupBack} m arrière · ${p.setupSide} m latéral`,
    `Point de snap : ${p.recBack} m arrière`,
    `Branche : ${p.legLen} m · ${p.legTime} s · début à ${p.legHeight} m`,
    `Cercles ${p.vref} m/s : setup ${r0(p.vref * t)} m · snap ${r0(p.vref * p.t2)} m`
  ].forEach((s2, i) => tx(s2, col2, l0 + i * lh, '#eee'));
  tx(`Imagerie © Esri, Maxar, Earthstar Geographics · Setup PSV v${VERSION}`, W - 20 * u, H - 10 * u, '#888', 8, false, 'right');

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
    if (navigator.canShare && navigator.canShare({ files: [pdfFile] })) { await navigator.share({ files: [pdfFile], title: pdfFile.name }); }
    else { const url = URL.createObjectURL(pdfFile); const a = document.createElement('a'); a.href = url; a.download = pdfFile.name; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 60000); }
    $('pdfReady').classList.add('hidden');
  } catch (e) { if (e && e.name !== 'AbortError') toast('Partage impossible'); }
});

// ---------- Sauvegarde ----------
$('btnExport').addEventListener('click', async () => {
  const data = JSON.stringify({ v: 2, zones, current, lastParams: current.params });
  try { await navigator.clipboard.writeText(data); toast('Données copiées : colle-les dans une note pour les garder'); }
  catch (e) { $('ioText').value = data; $('ioText').classList.remove('hidden'); toast('Copie auto impossible : sélectionne le texte'); }
});
$('btnImport').addEventListener('click', () => { $('ioText').value = ''; $('ioText').classList.remove('hidden'); $('btnImportGo').classList.remove('hidden'); });
$('btnImportGo').addEventListener('click', async () => {
  try {
    const d = JSON.parse($('ioText').value);
    if (!Array.isArray(d.zones)) throw 0;
    if (!(await ask(`Remplacer tes zones par les ${d.zones.length} zones importées ?`))) return;
    zones = d.zones.map(upgrade); store.set('psv.zones', zones);
    if (d.current) { current = upgrade(d.current); resetGateMarkers(); }
    fillInputs(); persist(); redraw(); renderZones(); toast('Import réussi');
    $('ioText').classList.add('hidden'); $('btnImportGo').classList.add('hidden');
  } catch (e) { toast('Données illisibles'); }
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
