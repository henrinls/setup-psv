/* barb.js — barbule cyan du vent au sol (commune à Setup PSV et prepo-PA ; même dessin que trace-isv et vecteur-largage).
   26 nov. 2026, demande d'Henri. Pictogramme des cartes aéronautiques : hampe dans le sens du vent, empennage côté au vent,
   demi-barre = 5 kt, barre = 10 kt, triangle = 50 kt ; petit rond si calme (< 2,5 kt).
   w = { dir (degrés vrais, d'où vient le vent), spd (m/s) } ; toPx(ll) → {x, y} (carte : latLngToContainerPoint ; PDF : toC). */
const Barb = (() => {
  const KT = 1.943844, CYAN = '#00e5ff';
  function geom(kt, C, d, s) {
    const n = { x: -d.y, y: d.x }, L0 = 16 * s, T = { x: C.x - d.x * L0 / 2, y: C.y - d.y * L0 / 2 }, H = { x: C.x + d.x * L0 / 2, y: C.y + d.y * L0 / 2 };
    const P = (a, m) => ({ x: T.x + d.x * a + n.x * m, y: T.y + d.y * a + n.y * m });
    const lines = [[T, H]], tris = [];
    let k5 = Math.round(kt / 5), a = 0; const F50 = Math.floor(k5 / 10); k5 -= F50 * 10; const B10 = Math.floor(k5 / 2), B5 = k5 % 2;
    if (!F50 && !B10 && !B5) return { lines: [], tris, calm: true, T: C };
    for (let i = 0; i < F50; i++) { tris.push([P(a, 0), P(a + 4 * s, 0), P(a, 9 * s)]); a += 5 * s; }
    for (let i = 0; i < B10; i++) { const b = P(a, 9 * s); lines.push([P(a, 0), { x: b.x - d.x * 2.5 * s, y: b.y - d.y * 2.5 * s }]); a += 3.5 * s; }
    if (B5) { if (!F50 && !B10) a += 3.5 * s; const b = P(a, 5 * s); lines.push([P(a, 0), { x: b.x - d.x * 1.4 * s, y: b.y - d.y * 1.4 * s }]); }
    return { lines, tris, T };
  }
  function box(g) { const pts = g.lines.flat().concat(g.tris.flat()); if (g.calm) pts.push({ x: g.T.x - 3, y: g.T.y - 3 }, { x: g.T.x + 3, y: g.T.y + 3 }); return { x0: Math.min(...pts.map(q => q.x)), y0: Math.min(...pts.map(q => q.y)), x1: Math.max(...pts.map(q => q.x)), y1: Math.max(...pts.map(q => q.y)) }; }
  /* sens à l'écran où va le vent, au point ll */
  function dirOf(w, ll, toPx) {
    const z = toPx(ll), r = (w.dir + 180) * Math.PI / 180, far = toPx(Geo.fromLocal(ll, { x: Math.sin(r) * 1000, y: Math.cos(r) * 1000 }));
    const d = { x: far.x - z.x, y: far.y - z.y }, l = Math.hypot(d.x, d.y) || 1; return { x: d.x / l, y: d.y / l };
  }
  /* barbule centrée sur le point que rend ctr(d) (d = sens à l'écran où va le vent) */
  function at(w, d, s, ctr) { const g0 = geom(w.spd * KT, { x: 0, y: 0 }, d, s), b = box(g0), c = ctr(d), dx = c.x - (b.x0 + b.x1) / 2, dy = c.y - (b.y0 + b.y1) / 2, mv = q => ({ x: q.x + dx, y: q.y + dy });
    return { lines: g0.lines.map(l => l.map(mv)), tris: g0.tris.map(t => t.map(mv)), calm: g0.calm, T: mv(g0.T) }; }
  const ok = w => w && isFinite(w.dir) && isFinite(w.spd);
  /* carte : SVG ajouté dans l'élément du marqueur (il suit le marqueur au zoom et au glissement) ; ctr(d) → centre en px dans le marqueur */
  function mount(el, w, ll, map, ctr) {
    if (!el) return; el.querySelectorAll('.barbIn').forEach(e => e.remove()); if (!ok(w) || !ll) return;
    const g = at(w, dirOf(w, ll, p => map.latLngToContainerPoint([p.lat, p.lng])), 1, ctr), B = box(g), x0 = B.x0 - 2, y0 = B.y0 - 2, x1 = B.x1 + 2, y1 = B.y1 + 2, f = q => `${(q.x - x0).toFixed(1)},${(q.y - y0).toFixed(1)}`;
    const body = g.lines.map(([a, b]) => `M${f(a)}L${f(b)}`).join('');
    const d = document.createElement('div'); d.className = 'barbIn';
    Object.assign(d.style, { position: 'absolute', left: `${x0.toFixed(1)}px`, top: `${y0.toFixed(1)}px`, width: `${(x1 - x0).toFixed(1)}px`, height: `${(y1 - y0).toFixed(1)}px`, pointerEvents: 'none' });
    d.innerHTML = `<svg width="${x1 - x0}" height="${y1 - y0}" style="overflow:visible;display:block"><path d="${body}" stroke="#000" stroke-width="2.6" stroke-linecap="round" fill="none" opacity=".55"/>${g.tris.map(t => `<path d="M${t.map(f).join('L')}Z" fill="${CYAN}" stroke="#000" stroke-width=".6"/>`).join('')}<path d="${body}" stroke="${CYAN}" stroke-width="1.1" stroke-linecap="round" fill="none"/>${g.calm ? `<circle cx="${(g.T.x - x0).toFixed(1)}" cy="${(g.T.y - y0).toFixed(1)}" r="2.5" stroke="${CYAN}" stroke-width="1.1" fill="none"/>` : ''}</svg>`;
    el.appendChild(d);
  }
  /* PDF : dessin sur le canvas g, échelle u ; ctr(d) → centre en px du canvas */
  function pdf(g, w, ll, toC, u, ctr) {
    if (!ok(w) || !ll) return;
    const bg = at(w, dirOf(w, ll, toC), u, ctr); g.save(); g.lineCap = 'round';
    const st = (col, lw) => { g.strokeStyle = col; g.lineWidth = lw; bg.lines.forEach(([p, q]) => { g.beginPath(); g.moveTo(p.x, p.y); g.lineTo(q.x, q.y); g.stroke(); }); if (bg.calm) { g.beginPath(); g.arc(bg.T.x, bg.T.y, 2.5 * u, 0, 2 * Math.PI); g.stroke(); } };
    st('rgba(0,0,0,.55)', 2.6 * u); bg.tris.forEach(t => { g.beginPath(); g.moveTo(t[0].x, t[0].y); t.slice(1).forEach(q => g.lineTo(q.x, q.y)); g.closePath(); g.fillStyle = CYAN; g.fill(); g.strokeStyle = '#000'; g.lineWidth = .6 * u; g.stroke(); }); st(CYAN, 1.1 * u); g.restore();
  }
  return { mount, pdf };
})();
