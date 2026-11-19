'use strict';
// Vents en ligne, commun à Setup PSV et prepo-PA (fichier identique dans les deux dépôts ; même source et même tableau que l'appli largage).
// Open-Meteo, gratuit, sans compte : Météo-France (AROME puis ARPEGE) jusqu'à J+3, puis ECMWF (mondial) ; prévisions gardées sur le téléphone.
// Toutes les directions sont gardées en vrai ; l'affichage est en magnétique (opts.decl()).
(function (root) {
  const PLEV = [1000, 950, 925, 900, 850, 800, 750, 700, 650, 600, 550, 500, 450, 400, 350, 300, 275, 250];
  const HLEV_MF = [10, 20, 50, 100, 150, 200], HLEV_EC = [10, 100];
  const KT = 1.943844;
  const pad2 = n => String(n).padStart(2, '0');
  const dayStr = d => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  const nowWhen = () => { const d = new Date(); return `${dayStr(d)}T${pad2(d.getHours())}:00`; };
  const shiftWhen = (w, h) => { const d = new Date(w + ':00'); d.setHours(d.getHours() + h); return `${dayStr(d)}T${pad2(d.getHours())}:00`; };
  const fmtWhen = w => { const d = new Date(w + ':00'); return `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)} ${pad2(d.getHours())}h`; };
  const n360 = h => ((h % 360) + 360) % 360;
  const fmt1 = v => (Math.round(v * 10) / 10).toString().replace('.', ',');
  const fmtInt = v => String(Math.round(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  const lsGet = k => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : null; } catch (e) { return null; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };
  const lsDel = k => { try { localStorage.removeItem(k); } catch (e) {} };

  function source(date) {
    const days = Math.round((new Date(date + 'T12:00') - new Date(dayStr(new Date()) + 'T12:00')) / 864e5);
    if (days <= 3) return { kind: 'mf', name: 'Météo-France (AROME, puis ARPEGE)', base: 'https://api.open-meteo.com/v1/meteofrance', models: 'meteofrance_seamless', hlev: HLEV_MF };
    return { kind: 'ec', name: 'ECMWF IFS (mondial)', base: 'https://api.open-meteo.com/v1/forecast', models: 'ecmwf_ifs025', hlev: HLEV_EC };
  }
  function url(lat, lng, date, src, minimal) {
    const v = [];
    (minimal ? [10] : src.hlev).forEach(h => v.push(`wind_speed_${h}m`, `wind_direction_${h}m`));
    v.push('temperature_2m'); if (!minimal && src.kind === 'mf') [20, 50, 100, 150, 200].forEach(h => v.push(`temperature_${h}m`));
    PLEV.forEach(p => v.push(`wind_speed_${p}hPa`, `wind_direction_${p}hPa`, `temperature_${p}hPa`, `geopotential_height_${p}hPa`));
    return `${src.base}?latitude=${lat.toFixed(4)}&longitude=${lng.toFixed(4)}&hourly=${v.join(',')}&models=${src.models}` +
      `&wind_speed_unit=ms&timezone=auto&start_date=${date}&end_date=${date}`;
  }
  // Profil à une heure : niveaux en hauteur sol, vent (u, v = vers où il souffle), température
  function profile(rec, when) {
    if (!rec) return null;
    const H = rec.hourly, i = (H.time || []).indexOf(when);
    if (i < 0) return null;
    const elev = typeof rec.elev === 'number' ? rec.elev : 0;
    const val = k => (H[k] && typeof H[k][i] === 'number') ? H[k][i] : null;
    const lv = [];
    const add = (h, spd, dir, T) => { if (spd == null || dir == null) return; const a = dir * Math.PI / 180; lv.push({ h, spd, dir, T, u: -spd * Math.sin(a), v: -spd * Math.cos(a) }); };
    Object.keys(H).filter(k => /^wind_speed_\d+m$/.test(k)).map(k => +k.match(/\d+/)[0]).sort((a, b) => a - b)
      .forEach(h => add(h, val(`wind_speed_${h}m`), val(`wind_direction_${h}m`), val(h === 10 ? 'temperature_2m' : `temperature_${h}m`)));
    const topH = lv.length ? lv[lv.length - 1].h : 0, pz = [];
    PLEV.forEach(p => {
      const z = val(`geopotential_height_${p}hPa`); if (z == null) return;
      pz.push({ p, z });
      if (z - elev > topH + 30) add(z - elev, val(`wind_speed_${p}hPa`), val(`wind_direction_${p}hPa`), val(`temperature_${p}hPa`));
    });
    lv.sort((a, b) => a.h - b.h); pz.sort((a, b) => b.p - a.p);
    return lv.length ? { lv, pz, elev } : null;
  }
  function interp(pr, h, key) {
    const L = pr.lv; if (h <= L[0].h) return L[0][key]; if (h >= L[L.length - 1].h) return L[L.length - 1][key];
    for (let k = 1; k < L.length; k++) if (h <= L[k].h) { const a = L[k - 1], b = L[k], f = (h - a.h) / (b.h - a.h); return a[key] == null || b[key] == null ? (a[key] ?? b[key]) : a[key] + (b[key] - a[key]) * f; }
    return null;
  }
  const windAt = (pr, h) => { const u = interp(pr, h, 'u'), v = interp(pr, h, 'v'); return { spd: Math.hypot(u, v), dir: n360(Math.atan2(-u, -v) * 180 / Math.PI) }; };
  // FL ↔ hauteur sol (atmosphère standard pour le FL, hauteurs géopotentielles de la prévision)
  const stdP = hm => 1013.25 * Math.pow(1 - 0.0065 * hm / 288.15, 5.25588);
  const stdH = p => (1 - Math.pow(p / 1013.25, 1 / 5.25588)) * 288.15 / 0.0065;
  function zOfP(pz, p) { if (!pz || pz.length < 2) return null; const lp = Math.log(p); let a = pz[0], b = pz[1]; for (let k = 1; k < pz.length; k++) { b = pz[k]; a = pz[k - 1]; if (p >= b.p) break; } return a.z + (b.z - a.z) * (lp - Math.log(a.p)) / (Math.log(b.p) - Math.log(a.p)); }
  function pOfZ(pz, z) { if (!pz || pz.length < 2) return null; let a = pz[0], b = pz[1]; for (let k = 1; k < pz.length; k++) { b = pz[k]; a = pz[k - 1]; if (z <= b.z) break; } return Math.exp(Math.log(a.p) + (Math.log(b.p) - Math.log(a.p)) * (z - a.z) / (b.z - a.z)); }
  const flToAgl = (fl, pr) => { const hs = fl * 30.48, z = zOfP(pr.pz, stdP(hs)); return (z == null ? hs : z) - pr.elev; };
  const aglToFl = (agl, pr) => { const p = pOfZ(pr.pz, agl + pr.elev); return (p == null ? agl + pr.elev : stdH(p)) / 30.48; };
  function rows(pr) { // une ligne par tranche de 1 000 ft, de la surface à ~10 000 m sol
    const out = [], add = (lab, h) => { const w = windAt(pr, h); out.push({ lab, h, dir: w.dir, spd: w.spd, T: interp(pr, h, 'T') }); };
    add('Sol (10 m)', 10);
    const fl0 = Math.ceil(aglToFl(30, pr) / 10) * 10;
    for (let fl = Math.max(10, fl0); fl <= 400; fl += 10) { const h = flToAgl(fl, pr); if (h > 10000) break; if (h > 20) add('FL' + String(fl).padStart(3, '0'), h); }
    return out;
  }

  // opts : { app: 'psv' | 'pa', where: () => ({ id, lat, lng }) | null, decl: () => degrés, onChange: () => {} }
  function make(opts) {
    const $ = id => document.getElementById(id);
    const mem = {}, failed = {};
    let when = nowWhen(), busy = false, userSet = false; // userSet : heure choisie à la main (sinon on suit l'heure actuelle)
    const key = (zid, date) => `${opts.app}.wx.${zid || 'tmp'}.${date}`;
    const cached = (zid, date) => { const k = key(zid, date); return mem[k] || (mem[k] = lsGet(k)); };
    const hdgN = d => String(Math.round(n360(d - (opts.decl ? opts.decl() : 0))) % 360).padStart(3, '0') + '°';
    async function fetchDay(z, date) {
      const src = source(date), ec = source('9999-12-31'), tries = [[src, false], [src, true]].concat(src.kind === 'mf' ? [[ec, false]] : []);
      let r = null, js = null, used = src;
      for (const [s2, minimal] of tries) {
        try { r = await fetch(url(z.lat, z.lng, date, s2, minimal)); if (r.ok) { js = await r.json(); used = s2; break; } } catch (e) { r = null; if (navigator.onLine === false) break; }
      }
      if (!js || !js.hourly) throw new Error('réseau');
      const rec = { date, fetched: Date.now(), model: used.name, elev: js.elevation, hourly: js.hourly, lat: z.lat, lng: z.lng };
      const k = key(z.id, date); mem[k] = rec; lsSet(k, rec);
      try { Object.keys(localStorage).filter(x => x.startsWith(`${opts.app}.wx.${z.id || 'tmp'}.`)).sort().slice(0, -4).forEach(x => { lsDel(x); delete mem[x]; }); } catch (e) {}
      return rec;
    }
    // Prévision du jour de `when` pour la zone : téléchargée si absente, vieille de plus d'1 h ou pour un autre endroit
    async function ensure(force) {
      const z = opts.where(); if (!z) return null;
      const date = when.slice(0, 10), have = cached(z.id, date);
      const moved = have && typeof have.lat === 'number' && (Math.abs(have.lat - z.lat) > 0.02 || Math.abs(have.lng - z.lng) > 0.02);
      if (have && !force && !moved && Date.now() - have.fetched < 3600e3) return have;
      if (busy) return have; busy = true; if ($('t_info')) $('t_info').textContent = 'Téléchargement de la prévision…';
      try { const r = await fetchDay(z, date); delete failed[date]; return r; }
      catch (e) { failed[date] = true; return have; }
      finally { busy = false; render(); if (opts.onChange) opts.onChange(); }
    }
    const rec = () => { const z = opts.where(); return z ? cached(z.id, when.slice(0, 10)) : null; };
    const prof = () => profile(rec(), when);
    function status(r) {
      if (!r) return navigator.onLine === false || failed[when.slice(0, 10)] ? '⚠️ Pas de réseau et aucune prévision gardée pour ce jour.' : 'Prévision en cours de téléchargement…';
      const d = new Date(r.fetched), st = `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)} à ${pad2(d.getHours())}h${pad2(d.getMinutes())}`;
      const ok = (r.hourly.time || []).includes(when);
      return `${r.model} · prévision téléchargée le ${st}${Date.now() - r.fetched > 3 * 3600e3 ? ' <b class="warn">(ancienne : mets à jour si tu as du réseau)</b>' : ''}${ok ? '' : ' <b class="warn">(pas de donnée à cette heure)</b>'}`;
    }
    function render() {
      const box = $('windsBox'); if (!box) return;
      const r = rec(), pr = profile(r, when);
      $('t_date').value = when.slice(0, 10); $('t_hour').value = when.slice(11, 13);
      $('t_info').innerHTML = status(r) + (r && typeof r.elev === 'number' ? ` · terrain ${Math.round(r.elev)} m` : '');
      const tb = $('windsTable').querySelector('tbody'); tb.innerHTML = '';
      if (!pr) { tb.innerHTML = '<tr><td colspan="6" class="mut">Pas de donnée pour cette heure.</td></tr>'; return; }
      rows(pr).forEach(x => {
        const tr = document.createElement('tr');
        tr.innerHTML = `<td>${x.lab}</td><td>${fmtInt(x.h)} m</td><td>${hdgN(x.dir)}</td><td>${Math.round(x.spd * KT)} kt</td><td>${fmt1(x.spd)} m/s</td><td>${x.T == null ? '–' : Math.round(x.T) + ' °C'}</td>`; // unité à côté de chaque chiffre
        tb.append(tr);
      });
    }
    function setWhen(w) { when = w; userSet = true; render(); if (opts.onChange) opts.onChange(); ensure(false); }
    const isOpen = () => !$('windsBox').classList.contains('hidden');
    function open() { $('windsBox').classList.remove('hidden'); render(); ensure(false); if (opts.onToggle) opts.onToggle(true); }
    function close() { $('windsBox').classList.add('hidden'); if (opts.onToggle) opts.onToggle(false); }
    $('t_close').addEventListener('click', close);
    $('t_minus').addEventListener('click', () => setWhen(shiftWhen(when, -1)));
    $('t_plus').addEventListener('click', () => setWhen(shiftWhen(when, 1)));
    $('t_now').addEventListener('click', () => { when = nowWhen(); userSet = false; render(); if (opts.onChange) opts.onChange(); ensure(true); });
    $('t_date').addEventListener('change', e => { if (e.target.value) setWhen(e.target.value + when.slice(10)); });
    $('t_hour').addEventListener('change', e => setWhen(when.slice(0, 11) + e.target.value + ':00'));
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      if (!userSet && nowWhen() !== when) { when = nowWhen(); render(); if (opts.onChange) opts.onChange(); }
      ensure(false);
    });
    return {
      open, close, isOpen, render, ensure,
      get when() { return when; }, fmtWhen,
      // Vent de surface (10 m) de la prévision à l'heure choisie : { dir (vrai, d'où il vient), spd (m/s) } ou null
      surface() { const pr = prof(); if (!pr) return null; const w = windAt(pr, 10); return isFinite(w.spd) ? w : null; },
      info() { const r = rec(); return r ? { model: r.model, fetched: r.fetched } : null; }
    };
  }
  root.WindPanel = { make, fmtWhen, nowWhen };
})(typeof window !== 'undefined' ? window : globalThis);
