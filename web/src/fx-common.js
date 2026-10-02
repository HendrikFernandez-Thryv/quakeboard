/* Shared animation plumbing: easing, tweens, count-up numbers, theme colours
   read from CSS, canvas sizing, and a frame loop that survives hidden tabs. */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.QBFX = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  const TAU = Math.PI * 2;
  const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
  const lerp = (a, b, t) => a + (b - a) * t;

  const ease = {
    linear: t => t,
    outQuad: t => 1 - (1 - t) * (1 - t),
    outCubic: t => 1 - Math.pow(1 - t, 3),
    inOutCubic: t => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
    outExpo: t => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t)),
    outBack: t => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); },
    smoothstep: (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); },
  };

  /* The app flips this from the OS setting and its own motion switch. Every
     animation here checks it, so "reduced" really does mean still. */
  const motion = { reduce: false };
  const setReducedMotion = v => { motion.reduce = !!v; };
  const reducedMotion = () => motion.reduce;

  /* A cancellable tween. `done` resolves true when it finishes and false if
     it was cancelled, so awaiting one can never hang. */
  function tween(duration, onFrame, easeFn) {
    easeFn = easeFn || ease.outCubic;
    let raf = 0, stopped = false, start = 0, finish;
    const done = new Promise(r => { finish = r; });
    if (motion.reduce || duration <= 0) {
      onFrame(1, 1); finish(true);
      return { done, cancel() {} };
    }
    function step(now) {
      if (stopped) return;
      if (!start) start = now;
      const raw = Math.min(1, (now - start) / duration);
      onFrame(easeFn(raw), raw);
      if (raw < 1) raf = requestAnimationFrame(step); else finish(true);
    }
    raf = requestAnimationFrame(step);
    return { done, cancel() { if (!stopped) { stopped = true; cancelAnimationFrame(raf); finish(false); } } };
  }

  /* Animate a number in an element from wherever it currently is. */
  function countUp(el, to, o) {
    o = o || {};
    const format = o.format || (v => Math.round(v).toLocaleString('en-US'));
    const from = o.from != null ? o.from : (Number(el.dataset.value) || 0);
    el.dataset.value = String(to);
    if (el._countUp) el._countUp.cancel();
    if (motion.reduce || from === to || to == null || !isFinite(to)) {
      el.textContent = to == null || !isFinite(to) ? '–' : format(to);
      return;
    }
    el._countUp = tween(o.duration || 900, p => { el.textContent = format(lerp(from, to, p)); }, ease.outExpo);
  }

  /* ------------------------------------------------------------- colours */

  function parseColor(str) {
    str = String(str || '').trim();
    let m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(str);
    if (m) {
      let h = m[1];
      if (h.length === 3) h = h.split('').map(c => c + c).join('');
      return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
    }
    m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(str);
    if (m) return [Math.round(+m[1]), Math.round(+m[2]), Math.round(+m[3])];
    return [128, 128, 128];
  }
  const rgba = (c, a) => 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + (a == null ? 1 : a) + ')';
  const mix = (a, b, t) => [Math.round(lerp(a[0], b[0], t)), Math.round(lerp(a[1], b[1], t)), Math.round(lerp(a[2], b[2], t))];

  /* Canvas colours live in CSS custom properties, so a theme change is one
     stylesheet edit and the canvases pick it up by calling this again. */
  function readTheme(el) {
    const cs = getComputedStyle(el || document.documentElement);
    const get = n => cs.getPropertyValue(n).trim();
    const c = n => parseColor(get(n));
    return {
      dark: get('--is-dark') === '1',
      ink: c('--ink'), ink2: c('--ink-2'), ink3: c('--ink-3'),
      accent: c('--accent'), surface: c('--surface'), bg: c('--bg'),
      tiers: [c('--m0'), c('--m1'), c('--m2'), c('--m3'), c('--m4')],
      oceanA: c('--cv-ocean-a'), oceanB: c('--cv-ocean-b'),
      land: c('--cv-land'), coast: c('--cv-coast'), grid: c('--cv-grid'),
      landFill: c('--cv-land-fill'), night: c('--cv-night'),
      ok: c('--ok'), warn: c('--warn'), bad: c('--bad'),
    };
  }

  /* ------------------------------------------------------------- canvases */

  /* Size a canvas's backing store to its CSS box at device resolution (capped
     at 2x - a 3x backing store quadruples the fill cost for no visible gain). */
  function fit(canvas) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const r = canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(r.width)), h = Math.max(1, Math.round(r.height));
    const pw = Math.round(w * dpr), ph = Math.round(h * dpr);
    const changed = canvas.width !== pw || canvas.height !== ph;
    if (changed) { canvas.width = pw; canvas.height = ph; }
    return { w, h, dpr, changed };
  }

  /* requestAnimationFrame with a clamped dt, so coming back to a tab that was
     hidden for an hour does not teleport every animation to its end. */
  class Loop {
    constructor(fn) { this.fn = fn; this.running = false; this.last = 0; this.raf = 0; this.step = this.step.bind(this); }
    start() { if (this.running) return; this.running = true; this.last = 0; this.raf = requestAnimationFrame(this.step); }
    stop() { this.running = false; cancelAnimationFrame(this.raf); }
    step(now) {
      if (!this.running) return;
      const dt = this.last ? Math.min(0.1, (now - this.last) / 1000) : 1 / 60;
      this.last = now;
      try { this.fn(dt, now / 1000); } catch (e) { console.error(e); }
      this.raf = requestAnimationFrame(this.step);
    }
  }

  const rand = (a, b) => a + Math.random() * (b - a);
  /* A stable pseudo-random 0..1 from a string, for per-event phase offsets. */
  function hash01(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return ((h >>> 0) % 10007) / 10007;
  }

  return { TAU, clamp, lerp, ease, tween, countUp, motion, setReducedMotion, reducedMotion,
           parseColor, rgba, mix, readTheme, fit, Loop, rand, hash01 };
});
