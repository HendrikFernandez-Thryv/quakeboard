/* The seismograph strip: three channels of scrolling trace. The ambient
   wiggle is synthetic; each real event from the feed injects a P-wave then a
   larger, longer S-wave, scaled by magnitude and tinted by its tier. It is an
   illustration driven by live data, not a recording, and the page says so. */
(function (root, factory) {
  var api = factory(root.QBFX || (typeof require === 'function' ? require('./fx-common.js') : null));
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.QBSeismo = api;
})(typeof self !== 'undefined' ? self : globalThis, function (FX) {
  'use strict';

  const TAU = FX.TAU, clamp = FX.clamp, rgba = FX.rgba;
  const FALLBACK = {
    ink: [230, 236, 250], ink2: [180, 191, 214], ink3: [138, 151, 181], accent: [92, 200, 255],
    tiers: [[125, 138, 168], [200, 74, 28], [240, 111, 38], [255, 157, 82], [255, 206, 163]],
  };

  class Seismograph {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.speed = 60;                       // pixels per second
      this.lanes = [
        { code: 'BHZ', gain: 1.0, seed: 1.7, n: 0 },
        { code: 'BHN', gain: 0.74, seed: 4.1, n: 0 },
        { code: 'BHE', gain: 0.6, seed: 7.9, n: 0 },
      ];
      this.bursts = [];
      this.t = 0;                            // timeline, in seconds
      this.acc = 0;
      this.w = 0; this.h = 0; this.dpr = 1; this.n = 0;
      this.buf = null;
      this.theme = null;
      this._ci = 0;
      this.resize();
    }
    setTheme(theme) { this.theme = theme; }

    resize() {
      const f = FX.fit(this.canvas);
      this.dpr = f.dpr;
      if (f.w === this.w && f.h === this.h && this.buf) return;
      this.w = f.w; this.h = f.h;
      this.n = f.w + 2;
      this.buf = this.lanes.map(() => ({ v: new Float32Array(this.n), ci: new Uint8Array(this.n) }));
      // Prefill with ambient noise so the trace spans the strip from the start.
      const step = 1 / this.speed, t0 = this.t - this.n * step;
      this.lanes.forEach((lane, li) => {
        for (let i = 0; i < this.n; i++) {
          this.buf[li].v[i] = this.sample(lane, t0 + i * step, true);
          this.buf[li].ci[i] = 0;
        }
      });
    }

    /* Queue a burst. `delay` seconds from now; `tier` picks the colour. */
    addBurst(o) {
      const mag = o.mag == null ? 4 : o.mag;
      const tauS = 1.5 + 0.9 * clamp(mag - 4, 0, 4), a0 = 0.8 + Math.random() * 0.3;
      this.bursts.push({
        t0: this.t + (o.delay || 0), mag, ci: (o.tier != null ? o.tier : 1) + 1,
        label: o.label || '', id: o.id || null,
        amp: 0.46 * Math.pow(1.45, clamp(mag, 2.5, 9) - 4),     // each magnitude unit is ~1.45x taller
        fP: FX.rand(3.0, 4.6), fS: FX.rand(1.6, 2.4), a0, tauS,
        p1: FX.rand(0, TAU), p2: FX.rand(0, TAU), p3: FX.rand(0, TAU),
        life: a0 + 6 * tauS,
      });
      if (this.bursts.length > 60) this.bursts.shift();
    }

    /* One sample of one channel at timeline time t. */
    sample(lane, t, ambientOnly) {
      let v = 0.10 * Math.sin(t * 1.3 + lane.seed) + 0.06 * Math.sin(t * 3.1 + lane.seed * 2.3) +
              0.025 * Math.sin(t * 7.7 + lane.seed * 4.1);
      lane.n = lane.n * 0.7 + (Math.random() - 0.5) * 0.3;
      v += lane.n * 0.12;
      let ci = 0;
      if (!ambientOnly) {
        for (let i = 0; i < this.bursts.length; i++) {
          const b = this.bursts[i], a = t - b.t0;
          if (a < 0 || a > b.life) continue;
          const pEnv = (1 - Math.exp(-a / 0.1)) * Math.exp(-a / 0.9);
          const as = a - b.a0;
          const sEnv = as >= 0 ? (1 - Math.exp(-as / 0.22)) * Math.exp(-as / b.tauS) : 0;
          const wave = 0.42 * pEnv * Math.sin(TAU * b.fP * a + b.p1) +
            (as >= 0 ? sEnv * (0.7 * Math.sin(TAU * b.fS * as + b.p2) + 0.3 * Math.sin(TAU * b.fS * 2.3 * as + b.p3)) : 0);
          v += b.amp * lane.gain * wave;
          if (pEnv + sEnv > 0.08) ci = Math.max(ci, b.ci);
        }
      }
      this._ci = ci;
      return Math.tanh(v * 1.2);
    }

    update(dt) {
      this.acc += dt * this.speed;
      const steps = Math.floor(this.acc);
      if (steps <= 0) return;
      this.acc -= steps;
      const step = 1 / this.speed, n = this.n;
      for (let k = 0; k < steps; k++) {
        this.t += step;
        for (let li = 0; li < this.lanes.length; li++) {
          const b = this.buf[li];
          b.v.copyWithin(0, 1); b.ci.copyWithin(0, 1);
          b.v[n - 1] = this.sample(this.lanes[li], this.t, false);
          b.ci[n - 1] = this._ci;
        }
      }
      const keep = Math.max(8, this.w / this.speed + 2);      // until labels have scrolled off
      this.bursts = this.bursts.filter(b => this.t - b.t0 < Math.max(b.life, keep));
    }

    draw() {
      const ctx = this.ctx, th = this.theme || FALLBACK, w = this.w, h = this.h, n = this.n;
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      // graph paper, scrolling with the trace
      const gx = 48, off = (this.t * this.speed) % gx;
      ctx.lineWidth = 1; ctx.strokeStyle = rgba(th.ink, 0.05);
      ctx.beginPath();
      for (let x = w - 1 - off; x > -gx; x -= gx) { const px = Math.round(x) + 0.5; ctx.moveTo(px, 0); ctx.lineTo(px, h); }
      ctx.stroke();

      const pad = 9, reserve = 18, laneH = (h - pad - reserve) / this.lanes.length;       // the bottom band is left for the caption
      const colour = (ci, a) => rgba(ci === 0 ? th.accent : th.tiers[ci - 1], a);

      this.lanes.forEach((lane, li) => {
        const cy = pad + laneH * (li + 0.5), amp = laneH * 0.66, b = this.buf[li];
        ctx.lineWidth = 1; ctx.strokeStyle = rgba(th.ink, 0.08);
        ctx.beginPath(); ctx.moveTo(0, Math.round(cy) + 0.5); ctx.lineTo(w, Math.round(cy) + 0.5); ctx.stroke();

        ctx.lineJoin = 'round'; ctx.lineCap = 'round';
        for (let pass = 0; pass < 2; pass++) {             // soft glow, then the sharp line
          ctx.lineWidth = pass === 0 ? 4 : 1.4;
          const alpha = pass === 0 ? 0.13 : 0.92;
          for (let i = 0; i < n;) {
            const ci = b.ci[i];
            let j = i;
            ctx.beginPath(); ctx.moveTo(i - 2, cy - b.v[i] * amp);
            while (j + 1 < n && b.ci[j + 1] === ci) { j++; ctx.lineTo(j - 2, cy - b.v[j] * amp); }
            if (j + 1 < n) ctx.lineTo(j - 1, cy - b.v[j + 1] * amp);    // join the next colour
            ctx.strokeStyle = colour(ci, ci === 0 ? alpha * 0.78 : alpha);
            ctx.stroke();
            i = j + 1;
          }
        }
        // the pen
        const py = cy - b.v[n - 1] * amp;
        ctx.fillStyle = rgba(th.accent, 0.18); ctx.beginPath(); ctx.arc(w - 1, py, 7, 0, TAU); ctx.fill();
        ctx.fillStyle = rgba(th.accent, 1); ctx.beginPath(); ctx.arc(w - 1, py, 2.6, 0, TAU); ctx.fill();
      });

      // fade the old end of the trace out
      ctx.globalCompositeOperation = 'destination-out';
      const fade = ctx.createLinearGradient(0, 0, w * 0.2, 0);
      fade.addColorStop(0, 'rgba(0,0,0,1)'); fade.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = fade; ctx.fillRect(0, 0, w * 0.2, h);
      ctx.globalCompositeOperation = 'source-over';

      // channel codes
      ctx.font = '500 10px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
      ctx.textBaseline = 'alphabetic'; ctx.fillStyle = rgba(th.ink3, 0.9);
      this.lanes.forEach((lane, li) => ctx.fillText(lane.code, 10, pad + laneH * li + 12));

      // event annotations, newest (rightmost) first so later ones yield
      ctx.font = '500 11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
      let limit = Infinity;
      this.bursts.filter(b => b.label && b.t0 <= this.t).sort((a, c) => c.t0 - a.t0).forEach(b => {
        const x = w - 1 - (this.t - b.t0) * this.speed;
        if (x < 54 || x > w - 4) return;
        const tw = ctx.measureText(b.label).width;
        let tx = x + 11;
        if (tx + tw > w - 8) tx = w - 8 - tw;
        if (tx + tw > limit - 10) return;                   // would collide with a newer label
        limit = tx;
        const fade = clamp((x - 54) / 140, 0, 1) * clamp((this.t - b.t0 + 0.05) / 0.3, 0, 1);
        ctx.fillStyle = rgba(th.tiers[b.ci - 1], 0.4 * fade);
        ctx.fillRect(Math.round(x), pad, 1, h - pad - reserve);
        ctx.fillStyle = rgba(th.tiers[b.ci - 1], fade);
        ctx.fillRect(Math.round(x) - 2, pad + 1, 7, 7);
        ctx.fillStyle = rgba(th.ink2, 0.95 * fade);
        ctx.fillText(b.label, tx, pad + 10);
      });
    }
  }

  return { Seismograph };
});
