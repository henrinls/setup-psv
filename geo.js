// Calculs géométriques purs (testables sans carte).
// Repère local : x = Est (m), y = Nord (m), origine = portes.
(function (root) {
  const R = 6378137;
  const rad = d => d * Math.PI / 180;

  function toLocal(o, p) {
    return {
      x: rad(p.lng - o.lng) * R * Math.cos(rad(o.lat)),
      y: rad(p.lat - o.lat) * R
    };
  }
  function fromLocal(o, v) {
    return {
      lat: o.lat + (v.y / R) * 180 / Math.PI,
      lng: o.lng + (v.x / (R * Math.cos(rad(o.lat)))) * 180 / Math.PI
    };
  }
  // Cap (° depuis le Nord, sens horaire) du vecteur local v
  function bearingOf(v) {
    return (Math.atan2(v.x, v.y) * 180 / Math.PI + 360) % 360;
  }
  // Vecteurs unitaires : f = sens du poser, r = droite du pilote en finale
  function basis(heading) {
    const h = rad(heading);
    return { f: { x: Math.sin(h), y: Math.cos(h) }, r: { x: Math.cos(h), y: -Math.sin(h) } };
  }
  // Point défini par un déport arrière (m) et un déport latéral (m, + = côté du virage)
  function offsetPoint(heading, turn, back, side) {
    const { f, r } = basis(heading);
    const s = turn === 'G' ? -1 : 1; // virage à gauche → côté gauche
    return { x: -back * f.x + s * side * r.x, y: -back * f.y + s * side * r.y };
  }

  // Calcule toute la figure en coordonnées locales.
  /* v3.31.0 (Henri) : virage réglable (p.turnDeg, 450° par défaut). L'étape de base est la route suivie AVANT le virage :
     cap du poser − virage (virage à droite) ou + virage (à gauche). Le setup est du côté d'où vient l'étape de base :
     à 450° (ou 90°), côté du virage ; à 270° (ou 630°), côté opposé — gauche et droite s'inversent. Déport latéral négatif :
     setup de l'autre côté, étape de base retournée (comme avant). */
  function turnGeom(p) {
    const { f, r } = basis(p.heading), s = p.turn === 'G' ? -1 : 1, T = isFinite(+p.turnDeg) && p.turnDeg !== '' && p.turnDeg != null ? +p.turnDeg : 450;
    const a = rad(p.heading - s * T), d = { x: Math.sin(a), y: Math.cos(a) }, lat = d.x * r.x + d.y * r.y;
    const side = lat < -1e-6 ? 1 : lat > 1e-6 ? -1 : s; /* côté du setup (+1 droite, −1 gauche), à l'opposé de là où va l'étape de base */
    return { f, r, s, side, d, T };
  }
  function compute(p) {
    const t1 = +p.t1 || 0, t2 = +p.t2 || 0, v = +p.vref || 0;
    const g = turnGeom(p), { f, r } = g, back = +p.setupBack || 0, sd = +p.setupSide || 0;
    const setup = { x: -back * f.x + g.side * sd * r.x, y: -back * f.y + g.side * sd * r.y };
    const rec = offsetPoint(p.heading, p.turn, +p.recBack || 0, 0);
    let d = g.d; if (sd < 0) { const la = d.x * r.x + d.y * r.y; d = { x: d.x - 2 * la * r.x, y: d.y - 2 * la * r.y }; } /* setup de l'autre côté : étape de base en miroir */
    const L = +p.legLen || 0;
    const legStart = { x: setup.x - L * d.x, y: setup.y - L * d.y };
    return {
      gates: { x: 0, y: 0 },
      setup, rec, legStart,
      legHeading: bearingOf(d), // cap suivi sur l'étape de base (vers le setup)
      setupSide: g.side, turnDeg: g.T,
      rSetup: v * (t1 + t2),
      rRec: v * t2,
      f, r
    };
  }

  // Pas des graduations selon le rayon affiché en pixels
  function tickSteps(radiusPx) {
    const circ = 2 * Math.PI * radiusPx;
    const pxPerDeg = circ / 360;
    const labelSteps = [1, 2, 5, 10, 15, 30, 45, 90];
    let label = null;
    for (const s of labelSteps) { if (s * pxPerDeg >= 38) { label = s; break; } }
    if (label === null) return null; // cercle trop petit : pas de graduation
    let minor = null;
    for (const d of [1, 2, 5, 10, 15]) {
      if (d < label && label % d === 0 && d * pxPerDeg >= 7) { minor = d; break; }
    }
    return { label, minor };
  }

  // Graduations « lisibles » demandées par Henri : peu de traits, tous chiffrés.
  // Niveaux : 90° seuls → 45° → 30/45/60/90 par quart → tous les 10°. On prend le plus fin
  // dont l'écart entre deux chiffres voisins reste ≥ 42 px sur le cercle.
  const DEG_LEVELS = [
    { minGap: 90, ok: d => d % 90 === 0 },
    { minGap: 45, ok: d => d % 45 === 0 },
    { minGap: 15, ok: d => d % 30 === 0 || d % 45 === 0 },
    { minGap: 10, ok: d => d % 10 === 0 }
  ];
  function degTicks(radiusPx, minPx) {
    const need = minPx || 42; let best = null;
    for (const L of DEG_LEVELS) if (radiusPx * L.minGap * Math.PI / 180 >= need) best = L;
    if (!best) return radiusPx >= 12 ? [0] : []; // tout petit cercle : juste le nord
    const out = []; for (let d = 0; d < 360; d += 5) if (best.ok(d)) out.push(d);
    return out;
  }

  const api = { toLocal, fromLocal, bearingOf, basis, offsetPoint, compute, turnGeom, tickSteps, degTicks };
  if (typeof module !== 'undefined') module.exports = api; else root.Geo = api;
})(this);
