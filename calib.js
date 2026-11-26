'use strict';
/* calib.js — étalonnage de la manœuvre sur la carte (26 nov. 2026, demande d'Henri), identique dans Setup PSV et prepo-PA.
   Déroulé : on pose un ou plusieurs points sur la carte (bandeau jaune, croix pour annuler), puis une fenêtre demande le vent
   (force en m/s, axe d'où il vient en degrés magnétiques avec −5 −1 +1 +5) et, si l'appli le veut, une hauteur.
   L'axe du vent est dessiné en pointillés orange passant par le point de référence (cible ou porte) ; une poignée à son bout
   (côté d'où vient le vent) se fait glisser pour le tourner. Valider rend la main à l'appli (onOk), qui met à jour la manœuvre.
   opts de start : { map, steps: [{ label, color }], anchor: pts => ll (reçoit les points posés), wind: { dir (vrai), spd (m/s) }, decl: () => degrés,
                     height: v => hauteur par défaut (ou null : pas de hauteur demandée), hLabel, title, onOk({ pts, dir, spd, h }), onEnd() } */
(function (root) {
  const $ = id => document.getElementById(id);
  const n360 = a => ((a % 360) + 360) % 360;
  let o = null, mode = null, idx = 0, pts = [], mks = [], w = { dir: 0, spd: 0 }, hTouched = false, axis = [], handle = null;
  function css() {
    if ($('calCss')) return;
    const s = document.createElement('style'); s.id = 'calCss';
    s.textContent = `#calPanel{position:fixed;left:50%;bottom:calc(10px + env(safe-area-inset-bottom));transform:translateX(-50%);width:min(420px,calc(100vw - 16px));z-index:1600;background:rgba(20,20,20,.94);border:1px solid #555;border-radius:12px;padding:10px 12px;color:#fff;box-sizing:border-box}
#calPanel h4{margin:0 0 6px;font-size:15px}#calPanel .row{display:flex;align-items:center;gap:6px;margin:6px 0}#calPanel label{flex:0 0 auto;min-width:96px;font-size:13px;color:#ccc}
#calPanel input{width:72px;font-size:16px;padding:6px;border-radius:7px;border:1px solid #666;background:#111;color:#fff;text-align:center}#calPanel .st button{min-width:38px;height:36px;padding:0 6px}
#calPanel .btns{display:flex;gap:8px;margin-top:8px}#calPanel .btns button{flex:1;height:42px}#calPanel .hint{font-size:12px;color:#aaa;margin:2px 0 0}
.calP span{display:block;width:16px;height:16px;margin:7px;border-radius:50%;border:2px solid #111;box-shadow:0 0 0 1.5px rgba(255,255,255,.8)}
.calH span{display:block;width:22px;height:22px;border-radius:50%;background:#ff8c00;border:2px solid #fff;box-shadow:0 0 0 1.5px #000}
#calChoose{position:fixed;inset:0;z-index:1700;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center}#calChoose .box{background:#1c1c1c;border:1px solid #555;border-radius:12px;padding:14px;width:min(360px,calc(100vw - 32px));color:#fff}
#calChoose .box p{margin:0 0 10px}#calChoose .box button{display:block;width:100%;height:44px;margin:6px 0}`;
    document.head.append(s);
  }
  /* fenêtre à choix : renvoie la valeur choisie, ou null si Annuler */
  function choose(text, options) {
    css();
    return new Promise(res => {
      const d = document.createElement('div'); d.id = 'calChoose';
      d.innerHTML = `<div class="box"><p></p></div>`; d.querySelector('p').textContent = text;
      const box = d.querySelector('.box');
      options.concat([{ label: 'Annuler', value: null }]).forEach(op => { const b = document.createElement('button'); b.textContent = op.label; if (op.value !== null) b.className = 'primary'; b.onclick = () => { d.remove(); res(op.value); }; box.append(b); });
      document.body.append(d);
    });
  }
  function banner(t) {
    const b = $('banner'); if (!b) return;
    b.textContent = t; b.classList.remove('hidden');
    const c = document.createElement('button'); c.className = 'bcancel'; c.textContent = '✕'; c.title = 'Annuler l\'étalonnage';
    c.onclick = e => { e.stopPropagation(); cancel(); };
    b.classList.add('hasx'); b.append(c);
  }
  function hideBanner() { const b = $('banner'); if (b) b.classList.add('hidden'); }
  function clearLayers() { mks.concat(axis, handle ? [handle] : []).forEach(l => { if (l && o && o.map.hasLayer(l)) o.map.removeLayer(l); }); mks = []; axis = []; handle = null; }
  function start(opts) {
    css(); if (mode) end(); o = opts; idx = 0; pts = [];
    if (o.steps && o.steps.length) { mode = 'place'; banner(o.steps[0].label); } else wind();
  }
  /* À appeler au début du clic sur la carte de l'appli : true = le clic est pris par l'étalonnage */
  function onMapClick(e) {
    if (!mode) return false;
    if (mode !== 'place') return true; /* fenêtre du vent ouverte : la carte ne pose rien */
    const p = { lat: e.latlng.lat, lng: e.latlng.lng }, st = o.steps[idx];
    pts.push(p); addPoint(pts.length - 1, st.color);
    idx++;
    if (idx < o.steps.length) banner(o.steps[idx].label); else { hideBanner(); wind(); }
    return true;
  }
  /* v3.31.3 / 1.16.2 (Henri) : un point posé reste déplaçable (appui long puis glisser), même pendant l'étape suivante */
  function addPoint(i, color) {
    const p = pts[i], m = L.marker([p.lat, p.lng], { zIndexOffset: 1400, icon: L.divIcon({ className: 'calP', iconSize: [30, 30], iconAnchor: [15, 15], html: `<span style="background:${color || '#ff2020'}"></span>` }) }).addTo(o.map);
    mks.push(m);
    const lp = root.longPressDrag; if (typeof lp === 'function') lp(m, ll => { pts[i] = { lat: ll.lat, lng: ll.lng }; m.setLatLng([ll.lat, ll.lng]); if (mode === 'wind') drawAxis(); }, () => { if (mode === 'wind') drawAxis(); });
  }
  function magOfTrue(t) { return Math.round(n360(t - (o.decl ? o.decl() : 0))); }
  function trueOfMag(m) { return n360(m + (o.decl ? o.decl() : 0)); }
  function drawAxis() {
    const map = o.map, A = o.anchor(pts); if (!A) return;
    axis.forEach(l => map.hasLayer(l) && map.removeLayer(l)); axis = [];
    const c = map.latLngToContainerPoint([A.lat, A.lng]), q = map.containerPointToLatLng([c.x + 100, c.y]), mpp = map.distance([A.lat, A.lng], q) / 100 || 1;
    const Lm = 150 * mpp, r = w.dir * Math.PI / 180, u = { x: Math.sin(r), y: Math.cos(r) };
    const P1 = Geo.fromLocal(A, { x: u.x * Lm, y: u.y * Lm }), P0 = Geo.fromLocal(A, { x: -u.x * Lm, y: -u.y * Lm });
    axis.push(L.polyline([[P0.lat, P0.lng], [P1.lat, P1.lng]], { color: '#000', weight: 4.5, opacity: .45, dashArray: '9 7', interactive: false }).addTo(map));
    axis.push(L.polyline([[P0.lat, P0.lng], [P1.lat, P1.lng]], { color: '#ff8c00', weight: 2.5, dashArray: '9 7', interactive: false }).addTo(map));
    /* flèche dans le sens du vent, au bout sous le vent (v3.31.3 / 1.16.2, Henri) */
    const T = map.latLngToContainerPoint([P0.lat, P0.lng]), C = map.latLngToContainerPoint([A.lat, A.lng]), dl = Math.hypot(T.x - C.x, T.y - C.y) || 1, dx = (T.x - C.x) / dl, dy = (T.y - C.y) / dl;
    const wing = sg => map.containerPointToLatLng([T.x - dx * 16 + sg * dy * 9, T.y - dy * 16 - sg * dx * 9]), w1 = wing(1), w2 = wing(-1), head = [[w1.lat, w1.lng], [P0.lat, P0.lng], [w2.lat, w2.lng]];
    axis.push(L.polyline(head, { color: '#000', weight: 5.5, opacity: .5, lineCap: 'round', lineJoin: 'round', interactive: false }).addTo(map));
    axis.push(L.polyline(head, { color: '#ff8c00', weight: 3, lineCap: 'round', lineJoin: 'round', interactive: false }).addTo(map));
    if (!handle) {
      handle = L.marker([P1.lat, P1.lng], { draggable: true, zIndexOffset: 1500, icon: L.divIcon({ className: 'calH', iconSize: [26, 26], iconAnchor: [13, 13], html: '<span></span>' }) }).addTo(map);
      handle.on('drag', () => { const A2 = o.anchor(pts), v = Geo.toLocal(A2, handle.getLatLng()); if (Math.hypot(v.x, v.y) < 1) return; w.dir = n360(Math.atan2(v.x, v.y) * 180 / Math.PI); syncPanel(); drawAxis(); });
      handle.on('dragend', () => drawAxis());
    } else if (!handle.dragging || !handle.dragging._draggable || !handle.dragging._draggable._moving) handle.setLatLng([P1.lat, P1.lng]);
  }
  function syncPanel() {
    const d = $('c_dir'); if (d && document.activeElement !== d) d.value = magOfTrue(w.dir);
    if (o.height && !hTouched) { const h = $('c_h'); if (h && document.activeElement !== h) h.value = Math.round(o.height(w.spd)); }
  }
  const num = el => parseFloat(String(el.value).trim().replace(',', '.'));
  function wind() {
    mode = 'wind'; w = { dir: n360(+o.wind.dir || 0), spd: Math.max(0, +o.wind.spd || 0) }; hTouched = false;
    let p = $('calPanel'); if (p) p.remove();
    p = document.createElement('div'); p.id = 'calPanel';
    p.innerHTML = `<h4></h4>
      <div class="row"><label>Force du vent</label><input id="c_spd" inputmode="decimal"> <span>m/s</span></div>
      <div class="row"><label>Axe (d'où il vient)</label><input id="c_dir" inputmode="numeric"> <span>° M</span></div>
      <div class="row st"><label></label><button data-d="-5">−5</button><button data-d="-1">−1</button><button data-d="1">+1</button><button data-d="5">+5</button></div>
      ${o.height ? `<div class="row"><label>${o.hLabel || 'Hauteur'}</label><input id="c_h" inputmode="decimal"> <span>m</span></div>` : ''}
      <p class="hint">L'axe orange passe par ${o.anchorName || 'le point de référence'} : fais glisser le rond orange pour le tourner.</p>
      <div class="btns"><button id="c_no">Annuler</button><button id="c_ok" class="primary">Valider</button></div>`;
    p.querySelector('h4').textContent = o.title || 'Vent au moment du saut';
    document.body.append(p);
    $('c_spd').value = String(Math.round(w.spd * 10) / 10).replace('.', ',');
    $('c_spd').addEventListener('input', e => { const v = num(e.target); if (!isNaN(v) && v >= 0) { w.spd = v; syncPanel(); } });
    $('c_dir').addEventListener('input', e => { const v = num(e.target); if (!isNaN(v)) { w.dir = trueOfMag(v); drawAxis(); } });
    $('c_dir').addEventListener('blur', syncPanel);
    p.querySelectorAll('[data-d]').forEach(b => b.addEventListener('click', () => { w.dir = trueOfMag(magOfTrue(w.dir) + +b.dataset.d); syncPanel(); drawAxis(); }));
    if (o.height) $('c_h').addEventListener('input', () => { hTouched = true; });
    $('c_no').onclick = cancel;
    $('c_ok').onclick = () => {
      const h = o.height ? num($('c_h')) : null;
      if (o.height && (isNaN(h) || h < 0)) { $('c_h').focus(); return; }
      const r = { pts: pts.slice(), dir: w.dir, spd: w.spd, h };
      end(); if (o.onOk) o.onOk(r);
    };
    syncPanel(); drawAxis();
    o.map.on('zoomend rotate viewreset', drawAxis);
  }
  function end() {
    if (o) o.map.off('zoomend rotate viewreset', drawAxis);
    const p = $('calPanel'); if (p) p.remove();
    if (mode === 'place') hideBanner();
    clearLayers(); const was = mode; mode = null;
    if (was && o && o.onEnd) o.onEnd();
  }
  function cancel() { end(); if (root.toast) try { root.toast('Étalonnage annulé'); } catch (e) {} }
  root.Calib = { start, onMapClick, choose, cancel, isActive: () => !!mode, get mode() { return mode; } };
})(typeof window !== 'undefined' ? window : globalThis);
