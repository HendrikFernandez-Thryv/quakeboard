/* App foundation: DOM helpers, settings, toasts, dialogs, small widgets. */
(function (global) {
  'use strict';
  const QB = global.QB, FX = global.QBFX;
  const App = global.App = global.App || {};
  const SVGNS = 'http://www.w3.org/2000/svg';

  /* ------------------------------------------------------------ DOM helpers */

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  /* Build an element. Children that are strings become text nodes - never
     HTML - so event data can't inject markup. */
  function h(tag, attrs) {
    const e = document.createElement(tag);
    if (attrs) for (const k in attrs) {
      const v = attrs[k];
      if (v == null || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k === 'text') e.textContent = v;
      else if (k === 'dataset') Object.assign(e.dataset, v);
      else if (k === 'style' && typeof v === 'object') Object.assign(e.style, v);
      else if (k.indexOf('on') === 0 && typeof v === 'function') e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v === true ? '' : v);
    }
    for (let i = 2; i < arguments.length; i++) {
      [].concat(arguments[i]).forEach(function (kid) {
        if (kid == null || kid === false) return;
        e.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
      });
    }
    return e;
  }
  function icon(name, cls) {
    const s = document.createElementNS(SVGNS, 'svg'), u = document.createElementNS(SVGNS, 'use');
    s.setAttribute('class', 'ico' + (cls ? ' ' + cls : '')); s.setAttribute('aria-hidden', 'true');
    u.setAttribute('href', '#i-' + name); s.appendChild(u);
    return s;
  }
  const clear = el => { while (el.firstChild) el.removeChild(el.firstChild); return el; };

  /* A tiny event bus, so modules need not know about each other. */
  const bus = {};
  const on = (name, fn) => { (bus[name] = bus[name] || []).push(fn); };
  const emit = (name, data) => (bus[name] || []).slice().forEach(fn => { try { fn(data); } catch (e) { console.error(e); } });

  /* ---------------------------------------------------------------- settings */

  const KEY = 'quakeboard.settings.v1';
  const DEFAULTS = {
    minMag: 4, period: 'day', interval: 60,
    searchMinMag: 2.5, days: 30, strict: false,
    alertMag: 5, alertRegions: [], sound: false, notify: false,
    home: null, homeRadiusKm: 300, bookmarks: [],
    theme: 'system', motion: 'system', view: 'globe', spin: true, dayNight: true,
  };
  function sanitize(s) {
    const num = (v, lo, hi, d) => { v = Number(v); return isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d; };
    const o = Object.assign({}, DEFAULTS, s);
    o.minMag = num(o.minMag, 1, 8, DEFAULTS.minMag);
    o.period = QB.FEEDS[o.period] ? o.period : 'day';
    o.interval = num(o.interval, 15, 3600, 60);
    o.searchMinMag = num(o.searchMinMag, 0, 8, 2.5);
    o.days = num(o.days, 0.05, 365, 30);
    o.alertMag = num(o.alertMag, 3, 9, 5);
    o.homeRadiusKm = num(o.homeRadiusKm, 10, 5000, 300);
    ['strict', 'sound', 'notify'].forEach(k => { o[k] = !!o[k]; });
    o.spin = o.spin !== false; o.dayNight = o.dayNight !== false;
    o.theme = ['system', 'dark', 'light'].indexOf(o.theme) >= 0 ? o.theme : 'system';
    o.motion = ['system', 'full', 'reduced'].indexOf(o.motion) >= 0 ? o.motion : 'system';
    o.view = o.view === 'flat' ? 'flat' : 'globe';
    o.alertRegions = (Array.isArray(o.alertRegions) ? o.alertRegions : []).filter(k => QB.regions.BOXES[k]).slice(0, 12);
    const hm = o.home;
    o.home = hm && isFinite(hm.lat) && isFinite(hm.lon) && Math.abs(hm.lat) <= 90 && Math.abs(hm.lon) <= 180
      ? { lat: +hm.lat, lon: +hm.lon, name: String(hm.name || 'Home').slice(0, 40) } : null;
    o.bookmarks = (Array.isArray(o.bookmarks) ? o.bookmarks : [])
      .filter(b => b && typeof b.query === 'string' && b.query.trim()).slice(0, 9)
      .map(b => ({ query: b.query.trim().slice(0, 60), minMag: b.minMag != null ? num(b.minMag, 0, 8, 2.5) : null,
                   days: b.days != null ? num(b.days, 0.05, 365, 30) : null, strict: !!b.strict }));
    return o;
  }
  function loadSettings() {
    try { return sanitize(JSON.parse(localStorage.getItem(KEY) || '{}')); } catch (e) { return sanitize({}); }
  }
  App.settings = loadSettings();
  /* Merge a patch, persist it, and tell everyone which keys changed. */
  App.set = function (patch) {
    const before = App.settings;
    App.settings = sanitize(Object.assign({}, before, patch));
    try { localStorage.setItem(KEY, JSON.stringify(App.settings)); } catch (e) { /* private mode */ }
    const changed = Object.keys(patch).filter(k => JSON.stringify(before[k]) !== JSON.stringify(App.settings[k]));
    if (changed.length) emit('settings', changed);
    return changed;
  };
  App.resetSettings = function () {
    try { localStorage.removeItem(KEY); } catch (e) {}
    const all = Object.keys(DEFAULTS);
    App.settings = sanitize({});
    emit('settings', all);
  };

  /* The API cache in localStorage: a few entries at most, so stale-on-failure
     survives a reload without ever filling the quota. */
  const CACHE_PREFIX = 'quakeboard.cache.', CACHE_INDEX = CACHE_PREFIX + 'index';
  QB.api.setStore({
    get(k) { try { return JSON.parse(localStorage.getItem(CACHE_PREFIX + k)); } catch (e) { return null; } },
    set(k, v) {
      try {
        const text = JSON.stringify(v);
        if (text.length > 1.4e6) return;
        let index = JSON.parse(localStorage.getItem(CACHE_INDEX) || '[]').filter(x => x !== k);
        index.push(k);
        while (index.length > 4) localStorage.removeItem(CACHE_PREFIX + index.shift());
        localStorage.setItem(CACHE_PREFIX + k, text);
        localStorage.setItem(CACHE_INDEX, JSON.stringify(index));
      } catch (e) { /* quota or private mode: the memo cache still works */ }
    },
  });
  App.clearCache = function () {
    let n = 0;
    try {
      Object.keys(localStorage).filter(k => k.indexOf(CACHE_PREFIX) === 0).forEach(k => { localStorage.removeItem(k); n++; });
    } catch (e) {}
    QB.api.clearMemo();
    return n;
  };

  /* ---------------------------------------------------------- small widgets */

  /* A segmented control with a sliding thumb. */
  function seg(el, onChange) {
    const thumb = $('.thumb', el), buttons = () => $$('button', el);
    function place() {
      const on = buttons().filter(b => b.getAttribute('aria-pressed') === 'true' || b.getAttribute('aria-selected') === 'true')[0];
      if (!on || !on.offsetWidth) return;
      el.style.setProperty('--x', on.offsetLeft + 'px'); el.style.setProperty('--w', on.offsetWidth + 'px');
    }
    function set(v) {
      buttons().forEach(b => b.setAttribute('aria-pressed', String(b.dataset.v === String(v))));
      place();
    }
    el.addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b || !el.contains(b)) return;
      set(b.dataset.v); if (onChange) onChange(b.dataset.v);
    });
    if (thumb) thumb.style.setProperty('transform', 'translateX(var(--x, 0))');
    if (window.ResizeObserver) new ResizeObserver(place).observe(el);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(place);
    return { set, place };
  }
  /* Slider whose filled track follows the thumb. */
  function range(input, valueEl, fmt, onInput, onChange) {
    const paint = () => {
      const pct = (input.value - input.min) / (input.max - input.min) * 100;
      input.style.setProperty('--pct', pct + '%');
      if (valueEl) valueEl.textContent = fmt(Number(input.value));
    };
    input.addEventListener('input', () => { paint(); if (onInput) onInput(Number(input.value)); });
    if (onChange) input.addEventListener('change', () => onChange(Number(input.value)));
    return { set(v) { input.value = v; paint(); }, paint };
  }

  /* ---------------------------------------------------------------- dialogs */

  function openDialog(dlg) {
    if (dlg.open) return;
    dlg.classList.remove('closing');
    dlg.showModal();
  }
  function closeDialog(dlg) {
    if (!dlg.open || dlg.classList.contains('closing')) return;
    if (FX.reducedMotion()) { dlg.close(); return; }
    dlg.classList.add('closing');
    let done = false;
    const finish = () => { if (done) return; done = true; dlg.classList.remove('closing'); dlg.close(); };
    dlg.addEventListener('animationend', function once(e) { if (e.target === dlg) { dlg.removeEventListener('animationend', once); finish(); } });
    setTimeout(finish, 400);
  }
  function wireDialog(dlg) {
    dlg.addEventListener('cancel', e => { e.preventDefault(); closeDialog(dlg); });
    dlg.addEventListener('click', e => { if (e.target === dlg || e.target.closest('[data-close]')) closeDialog(dlg); });
  }

  /* ----------------------------------------------------------------- toasts */

  const TIER_NAMES = ['below M4', 'M4 to 4.9', 'M5 to 5.9', 'M6 to 6.9', 'M7 or more'];
  function toast(o) {
    const box = $('#toasts'), life = o.life || 7000;
    const tier = o.tier != null ? 't' + o.tier : '';
    const el = h('div', { class: 'toast ' + tier, role: 'group', style: { '--life': life + 'ms' } },
      h('div', { class: 'tmag' }, o.mag ? h('b', { text: o.mag }) : icon(o.icon || 'info')),
      h('div', null, h('div', { class: 'tt', text: o.title }), o.body ? h('div', { class: 'tb', text: o.body }) : null),
      h('button', { class: 'tx', type: 'button', 'aria-label': 'Dismiss' }, icon('close')));
    const dismiss = () => {
      if (el._gone) return; el._gone = true; clearTimeout(timer);
      el.classList.add('out'); setTimeout(() => el.remove(), FX.reducedMotion() ? 0 : 360);
    };
    const timer = setTimeout(dismiss, life);
    el.addEventListener('click', e => { if (e.target.closest('.tx')) return dismiss(); if (o.onClick) o.onClick(); dismiss(); });
    box.appendChild(el);
    while (box.children.length > 4) box.firstChild.remove();
    return dismiss;
  }

  /* One shared tooltip for charts. `text` is [strong, line, line...] or null. */
  function chartTip(lines, x, y) {
    const tip = $('#chart-tip');
    if (!lines) { tip.classList.remove('show'); return; }
    clear(tip);
    tip.appendChild(h('b', { text: lines[0] }));
    lines.slice(1).forEach(l => tip.appendChild(h('div', { class: 'line', text: l })));
    tip.style.left = Math.max(120, Math.min(innerWidth - 120, x)) + 'px'; tip.style.top = Math.max(60, y) + 'px';
    tip.classList.add('show');
  }
  /* Announce something to screen readers without moving focus. */
  function say(text) { const r = $('#sr-live'); r.textContent = ''; setTimeout(() => { r.textContent = text; }, 40); }

  /* ------------------------------------------------ sound and notifications */

  let actx = null;
  /* A synthesised low rumble: a falling sine plus brown noise through a
     low-pass. Louder and longer for bigger events. No audio files. */
  function rumble(mag) {
    try {
      actx = actx || new (global.AudioContext || global.webkitAudioContext)();
      if (actx.state === 'suspended') actx.resume();
      const t0 = actx.currentTime, m = Math.max(3, Math.min(9, mag || 5));
      const dur = 1.6 + (m - 4) * 0.7, vol = Math.min(0.45, 0.1 + (m - 4) * 0.07);
      const master = actx.createGain();
      master.gain.setValueAtTime(0.0001, t0); master.gain.exponentialRampToValueAtTime(vol, t0 + 0.14);
      master.gain.exponentialRampToValueAtTime(0.0005, t0 + dur); master.connect(actx.destination);
      const osc = actx.createOscillator(); osc.type = 'sine';
      osc.frequency.setValueAtTime(62, t0); osc.frequency.exponentialRampToValueAtTime(30, t0 + dur); osc.connect(master);
      const len = Math.ceil(actx.sampleRate * dur), buf = actx.createBuffer(1, len, actx.sampleRate), d = buf.getChannelData(0);
      let last = 0; for (let i = 0; i < len; i++) { last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02; d[i] = last * 3.4; }
      const noise = actx.createBufferSource(); noise.buffer = buf;
      const lp = actx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 150; noise.connect(lp); lp.connect(master);
      osc.start(t0); noise.start(t0); osc.stop(t0 + dur); noise.stop(t0 + dur);
    } catch (e) { /* no audio available */ }
  }
  function osNotify(title, body, tag) {
    try {
      if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
      new Notification(title, { body, tag, silent: true });
    } catch (e) { /* some browsers only allow this from a service worker */ }
  }
  async function askNotifyPermission() {
    if (typeof Notification === 'undefined') return 'unsupported';
    if (Notification.permission !== 'default') return Notification.permission;
    try { return await Notification.requestPermission(); } catch (e) { return 'denied'; }
  }

  /* ------------------------------------------------------------------ export */

  const csvCell = v => {
    let s = v == null ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(s) && isNaN(Number(s))) s = "'" + s;          // neutralise spreadsheet formulas
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  function exportCsv(quakes, label, home) {
    const head = ['time_utc', 'magnitude', 'mag_type', 'depth_km', 'latitude', 'longitude']
      .concat(home ? ['km_from_home'] : []).concat(['place', 'tsunami', 'alert', 'status', 'id', 'url']);
    const rows = quakes.map(q => {
      const km = home ? QB.geo.haversine(home.lat, home.lon, q.lat, q.lon) : null;
      return [q.utcTime(), q.mag, q.magType, q.depthKm, q.lat, q.lon].concat(home ? [km == null ? '' : km.toFixed(1)] : [])
        .concat([q.place, q.tsunami ? 1 : 0, q.alert || '', q.status, q.id, q.safeUrl()]);
    });
    const text = [head].concat(rows).map(r => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
    const slug = String(label || 'quakes').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'quakes';
    const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '');
    const name = 'quakes-' + slug + '-' + stamp + '.csv';
    const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
    const a = h('a', { href: url, download: name }); document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    return { name, count: quakes.length };
  }
  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); return true; } catch (e) {
      const ta = h('textarea', { style: { position: 'fixed', opacity: '0' } }); ta.value = text; document.body.appendChild(ta); ta.select();
      let ok = false; try { ok = document.execCommand('copy'); } catch (e2) {} ta.remove(); return ok;
    }
  }

  /* ---------------------------------------------------------- small formats */

  const whenShort = q => q.timeMs == null ? 'unknown time'
    : new Date(q.timeMs).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  const plural = (n, one, many) => n + ' ' + (n === 1 ? one : (many || one + 's'));
  const depthLabel = q => q.depthKm == null ? null : (q.depthKm < 0 ? '<1' : Math.round(q.depthKm)) + ' km deep';

  Object.assign(App, { $, $$, h, icon, clear, on, emit, seg, range, openDialog, closeDialog, wireDialog, toast, chartTip, say,
    rumble, osNotify, askNotifyPermission, exportCsv, copyText, whenShort, plural, depthLabel, TIER_NAMES, DEFAULTS });
})(self);
