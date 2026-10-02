/* Charts. Each follows the same few rules: thin marks, a 2px surface ring on
   overlapping dots, hairline solid gridlines, selective labels, a hit area
   well over 24px, and a table view that carries every value a tooltip does. */
(function (root, factory) {
  var api = factory(root.QBFX || (typeof require === 'function' ? require('./fx-common.js') : null));
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.QBCharts = api;
})(typeof self !== 'undefined' ? self : globalThis, function (FX) {
  'use strict';

  const TAU = Math.PI * 2, clamp = FX.clamp, rgba = FX.rgba, ease = FX.ease;
  const SVGNS = 'http://www.w3.org/2000/svg';
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const svg = (tag, attrs) => { const e = document.createElementNS(SVGNS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); return e; };

  /* ---------------------------------------------------------- pure helpers */

  /* Round tick values that span [lo, hi] in about `want` steps. The step is
     the round number (1, 2, 2.5, 5 x a power of ten) nearest to lo-hi / want. */
  function niceTicks(lo, hi, want) {
    if (!(hi > lo)) return [lo];
    const raw = (hi - lo) / Math.max(1, want), pow = Math.pow(10, Math.floor(Math.log10(raw)));
    let step = pow, best = Infinity;
    for (const m of [1, 2, 2.5, 5, 10]) {
      const off = Math.abs(Math.log(m * pow / raw));
      if (off < best) { best = off; step = m * pow; }
    }
    const out = [], clean = v => Number(v.toPrecision(12));        // 6 * 0.2 is 1.2000000000000002
    for (let k = Math.ceil(lo / step - 1e-9); k * step <= hi + step * 1e-9; k++) out.push(clean(k * step));
    return out;
  }
  /* Time-since-mainshock ticks land on hours, days or weeks, never 1.7d. */
  function timeTicks(lo, hi, want) {
    const span = hi - lo, steps = [1 / 24, 3 / 24, 6 / 24, 12 / 24, 1, 2, 5, 7, 10, 14, 30];
    let step = steps[steps.length - 1];
    for (const s of steps) if (span / s <= want) { step = s; break; }
    const out = [];
    for (let v = Math.ceil(lo / step - 1e-9) * step; v <= hi + 1e-9; v += step) out.push(Math.round(v / step) * step);
    return out;
  }
  function timeLabel(days) {
    if (Math.abs(days) < 1e-9) return '0';
    const sign = days < 0 ? '−' : '+', a = Math.abs(days);
    return sign + (a < 1 ? Math.round(a * 24) + 'h' : (Math.round(a * 10) / 10) + 'd');
  }

  /* ------------------------------------------------------------ sparkline */

  /* 12 points, the older ones quiet, the current period in the accent. */
  function sparkline(values, o) {
    o = o || {};
    const w = o.w || 112, h = o.h || 30, pad = 4;
    const s = svg('svg', { class: 'spark', viewBox: '0 0 ' + w + ' ' + h, width: w, height: h, role: 'img', 'aria-label': o.label || 'trend' });
    const max = Math.max(1, ...values), n = values.length;
    const pts = values.map((v, i) => [pad + (n < 2 ? 0 : i * (w - pad * 2) / (n - 1)), h - pad - (v / max) * (h - pad * 2)]);
    const d = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ');
    const base = svg('path', { d, class: 'spark-base', fill: 'none' });
    const cur = svg('path', { d: pts.slice(-2).map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' '), class: 'spark-cur', fill: 'none' });
    const last = pts[pts.length - 1] || [pad, h / 2];
    const ring = svg('circle', { cx: last[0], cy: last[1], r: 5, class: 'spark-ring' });
    const dot = svg('circle', { cx: last[0], cy: last[1], r: 3.4, class: 'spark-dot' });
    [base, cur, ring, dot].forEach(x => s.appendChild(x));
    // draw-on entrance
    if (!FX.reducedMotion() && base.getTotalLength) {
      try {
        const len = base.getTotalLength();
        base.style.strokeDasharray = len; base.style.strokeDashoffset = len;
        [cur, ring, dot].forEach(x => { x.style.opacity = 0; });
        requestAnimationFrame(() => requestAnimationFrame(() => {
          base.style.transition = 'stroke-dashoffset 900ms cubic-bezier(.2,.8,.2,1)'; base.style.strokeDashoffset = 0;
          [cur, ring, dot].forEach(x => { x.style.transition = 'opacity 300ms 700ms'; x.style.opacity = 1; });
        }));
      } catch (e) { /* jsdom and friends: no geometry, no animation */ }
    }
    return s;
  }

  /* ------------------------------------------------------------ bar rows */

  /* Horizontal bars on a shared scale. The track is a lighter step of the
     bar's own colour, and the value sits at the tip. */
  function barRows(container, rows, o) {
    o = o || {};
    container.textContent = '';
    const max = Math.max(1, ...rows.map(r => r.value || 0));
    rows.forEach((r, i) => {
      const row = el('div', 'brow'), label = el('span', 'blabel', r.label);
      if (r.mark) { const m = el('i', 'bmark'); m.style.background = r.mark; label.prepend(m); }
      const track = el('span', 'btrack'), fill = el('span', 'bfill');
      fill.style.setProperty('--c', r.color || 'var(--accent)');
      fill.style.width = '0%';
      track.appendChild(fill);
      const val = el('span', 'bval', r.value == null ? '–' : (r.text || r.value.toLocaleString('en-US')));
      row.append(label, track, val);
      if (r.title) row.title = r.title;
      container.appendChild(row);
      const pct = r.value ? Math.max(1.5, r.value / max * 100) : 0;
      const go = () => { fill.style.width = pct + '%'; };
      if (FX.reducedMotion()) go(); else setTimeout(() => requestAnimationFrame(go), 80 + i * 70);
    });
  }

  /* ------------------------------------------------------ table twin view */

  function dataTable(cols, rows, caption) {
    const t = el('table', 'dt'); if (caption) t.appendChild(el('caption', 'sr-only', caption));
    const head = el('tr'); cols.forEach(c => { const th = el('th', c.num ? 'num' : '', c.label); th.scope = 'col'; head.appendChild(th); });
    const thead = el('thead'); thead.appendChild(head); t.appendChild(thead);
    const body = el('tbody');
    rows.forEach(r => {
      const tr = el('tr');
      cols.forEach((c, i) => tr.appendChild(el('td', c.num ? 'num' : '', r[i] == null ? '–' : String(r[i]))));
      body.appendChild(tr);
    });
    t.appendChild(body);
    return t;
  }

  /* --------------------------------------------------- magnitude vs time */

  class TimelineChart {
    constructor(canvas, o) {
      this.canvas = canvas; this.ctx = canvas.getContext('2d'); this.o = o || {};
      this.pts = []; this.main = null; this.hover = null; this.progress = 0; this.theme = null;
      this.w = 0; this.h = 0; this.dpr = 1; this.m = { l: 40, r: 14, t: 16, b: 28 };
      this.tween = null;
      canvas.addEventListener('pointermove', e => this.onMove(e));
      canvas.addEventListener('pointerleave', () => { this.hover = null; this.draw(); if (this.o.onHover) this.o.onHover(null); });
      canvas.addEventListener('pointerdown', e => this.onMove(e));
    }
    /* `pts` come from Sequence.points(); `main` is the mainshock Quake. */
    set(main, pts, elapsedDays) {
      this.main = main; this.pts = pts.filter(p => p.quake.mag != null);
      const days = this.pts.map(p => p.days), mags = this.pts.map(p => p.quake.magnitude).concat([main.magnitude]);
      const lo = Math.min(-0.25, ...days), hi = Math.max(elapsedDays, 0.5, ...days);
      const pad = (hi - lo) * 0.03;
      this.x0 = lo - pad; this.x1 = hi + pad;
      const minM = Math.min(...mags), maxM = Math.max(...mags);
      this.y0 = Math.floor(minM * 2) / 2 - 0.25; this.y1 = Math.ceil(maxM * 2) / 2 + 0.25;
      this.now = elapsedDays;
      this.sorted = this.pts.slice().sort((a, b) => a.quake.magnitude - b.quake.magnitude);
      this.resize(); this.animate();
    }
    resize() { const f = FX.fit(this.canvas); this.w = f.w; this.h = f.h; this.dpr = f.dpr; }
    animate() {
      if (this.tween) this.tween.cancel();
      this.tween = FX.tween(1300, p => { this.progress = p; this.draw(); }, ease.linear);
    }
    X(d) { return this.m.l + (d - this.x0) / (this.x1 - this.x0) * (this.w - this.m.l - this.m.r); }
    Y(m) { return this.m.t + (1 - (m - this.y0) / (this.y1 - this.y0)) * (this.h - this.m.t - this.m.b); }
    radius(mag) { return clamp(3.6 + (mag - 3) * 1.3, 3.6, 11); }
    onMove(e) {
      const r = this.canvas.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
      let best = null, bd = 1e9;
      for (const p of this.pts) {
        const d = Math.hypot(this.X(p.days) - x, this.Y(p.quake.magnitude) - y);
        if (d < bd) { bd = d; best = p; }
      }
      const hit = best && bd <= 18 ? best : null;                   // nearest-point layer, >24px wide
      if (hit !== this.hover) { this.hover = hit; this.draw(); }
      if (this.o.onHover) this.o.onHover(hit, hit ? r.left + this.X(hit.days) : 0, hit ? r.top + this.Y(hit.quake.magnitude) : 0);
    }
    draw() {
      if (!this.main || !this.w) return;
      const th = this.theme = FX.readTheme(), ctx = this.ctx, w = this.w, h = this.h, m = this.m, p = this.progress;
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0); ctx.clearRect(0, 0, w, h);
      const axisA = ease.outCubic(clamp(p / 0.25, 0, 1));
      ctx.font = '500 11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
      ctx.fillStyle = rgba(th.ink3, axisA); ctx.textBaseline = 'middle'; ctx.textAlign = 'right';
      ctx.lineWidth = 1;
      const ticksY = niceTicks(this.y0, this.y1, 5);
      ticksY.forEach(v => {
        const y = Math.round(this.Y(v)) + 0.5;
        ctx.strokeStyle = rgba(th.ink, 0.07 * axisA); ctx.beginPath(); ctx.moveTo(m.l, y); ctx.lineTo(w - m.r, y); ctx.stroke();
        ctx.fillText(v.toFixed(v % 1 ? 1 : 0), m.l - 8, y);
      });
      ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      timeTicks(this.x0, this.x1, Math.max(3, Math.floor((w - m.l - m.r) / 70))).forEach(v => {
        const x = Math.round(this.X(v)) + 0.5;
        ctx.strokeStyle = rgba(th.ink, (Math.abs(v) < 1e-9 ? 0.22 : 0.05) * axisA); ctx.beginPath(); ctx.moveTo(x, m.t); ctx.lineTo(x, h - m.b); ctx.stroke();
        ctx.fillText(timeLabel(v), x, h - m.b + 8);
      });
      ctx.strokeStyle = rgba(th.ink, 0.18 * axisA); ctx.beginPath(); ctx.moveTo(m.l, h - m.b + 0.5); ctx.lineTo(w - m.r, h - m.b + 0.5); ctx.stroke();

      // events, weakest first so the strong ones stay on top; they arrive in order
      const n = this.sorted.length, arrive = 0.25 + 0.6 * p;
      const order = new Map(this.pts.map((q, i) => [q, i]));
      this.sorted.forEach(q => {
        const i = order.get(q), start = 0.15 + 0.7 * (i / Math.max(1, this.pts.length)), k = clamp((p - start) / 0.18, 0, 1);
        if (k <= 0) return;
        const x = this.X(q.days), y = this.Y(q.quake.magnitude), r = this.radius(q.quake.magnitude) * ease.outBack(k);
        const hot = q === this.hover;
        ctx.beginPath(); ctx.arc(x, y, r + 2, 0, TAU); ctx.fillStyle = rgba(th.surface, 1); ctx.fill();       // 2px surface ring
        ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fillStyle = rgba(th.tiers[q.quake.tier()], 0.94); ctx.fill();
        if (hot) { ctx.beginPath(); ctx.arc(x, y, r + 4, 0, TAU); ctx.lineWidth = 2; ctx.strokeStyle = rgba(th.ink, 1); ctx.stroke(); ctx.lineWidth = 1; }
      });

      // the mainshock: a star, larger than anything else, labelled
      const mk = ease.outBack(clamp(p / 0.2, 0, 1)), mx = this.X(0), my = this.Y(this.main.magnitude), R = 12 * mk;
      if (mk > 0) {
        ctx.beginPath();
        for (let i = 0; i < 10; i++) { const a = -Math.PI / 2 + i * Math.PI / 5, rr = i % 2 ? R * 0.45 : R; ctx[i ? 'lineTo' : 'moveTo'](mx + Math.cos(a) * rr, my + Math.sin(a) * rr); }
        ctx.closePath(); ctx.lineWidth = 3; ctx.strokeStyle = rgba(th.surface, 1); ctx.stroke();
        ctx.fillStyle = rgba(th.tiers[this.main.tier()], 1); ctx.fill();
        ctx.fillStyle = rgba(th.ink, axisA); ctx.textAlign = mx > w * 0.6 ? 'right' : 'left'; ctx.textBaseline = 'middle';
        ctx.fillText('M' + this.main.magText() + ' mainshock', mx + (mx > w * 0.6 ? -R - 6 : R + 6), my - 1);
      }
      // "now"
      const nx = this.X(this.now);
      ctx.strokeStyle = rgba(th.accent, 0.7 * axisA); ctx.beginPath(); ctx.moveTo(Math.round(nx) + 0.5, m.t); ctx.lineTo(Math.round(nx) + 0.5, h - m.b); ctx.stroke();
      ctx.fillStyle = rgba(th.accent, axisA); ctx.textAlign = 'right'; ctx.textBaseline = 'top'; ctx.fillText('now', nx - 5, m.t + 1);
    }
  }

  /* ------------------------------------------------------- aftershocks/day */

  /* Columns no wider than 24px, rounded at the tip and square at the
     baseline, separated by a 2px gap. Each one is focusable. */
  function dailyBars(container, counts, o) {
    o = o || {};
    container.textContent = '';
    const max = Math.max(1, ...counts), peak = counts.indexOf(Math.max(...counts));
    const plot = el('div', 'dbars'); plot.setAttribute('role', 'list');
    counts.forEach((c, i) => {
      const col = el('div', 'dcol'); col.setAttribute('role', 'listitem');
      const bar = el('button', 'dbar'); bar.type = 'button';
      const label = 'Day ' + (i + 1) + ': ' + c + (c === 1 ? ' aftershock' : ' aftershocks');
      bar.setAttribute('aria-label', label); bar.dataset.tip = label;
      bar.style.height = '0%';
      const showValue = c > 0 && (i === peak || i === counts.length - 1);
      if (showValue) bar.appendChild(el('span', 'dval', String(c)));
      const track = el('div', 'dtrack'); track.appendChild(bar);
      col.append(track, el('span', 'dlab', 'd' + (i + 1)));
      plot.appendChild(col);
      const pct = c ? Math.max(3, c / max * 100) : 0, go = () => { bar.style.height = pct + '%'; };
      if (FX.reducedMotion()) go(); else setTimeout(() => requestAnimationFrame(go), 120 + i * 60);
      if (o.onHover) {
        const show = () => { const r = bar.getBoundingClientRect(); o.onHover(label, r.left + r.width / 2, r.top); };
        bar.addEventListener('pointerenter', show); bar.addEventListener('focus', show);
        bar.addEventListener('pointerleave', () => o.onHover(null)); bar.addEventListener('blur', () => o.onHover(null));
      }
    });
    container.appendChild(plot);
  }

  return { niceTicks, timeTicks, timeLabel, sparkline, barRows, dataTable, TimelineChart, dailyBars, el, svg };
});
