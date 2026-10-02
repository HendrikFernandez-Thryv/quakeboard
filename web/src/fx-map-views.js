/* The two map renderers - a dotted, rotatable globe and a flat Mercator map -
   and the Stage that runs them. Both draw the same EventLayer; the Stage
   owns the frame loop, pointer handling and the globe/flat crossfade. */
(function (root, factory) {
  var fx = root.QBFX || (typeof require === 'function' ? require('./fx-common.js') : null);
  var core = root.QBMapCore || (typeof require === 'function' ? require('./fx-map-core.js') : null);
  var api = factory(fx, core);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.QBMap = api;
})(typeof self !== 'undefined' ? self : globalThis, function (FX, MC) {
  'use strict';

  const TAU = Math.PI * 2, D2R = MC.D2R, R2D = MC.R2D;
  const { clamp, lerp, ease, rgba } = FX;
  const DOT_LATTICE = 44000;       // sphere samples before the land filter

  function shortestLon(from, to) { return from + ((((to - from + 180) % 360) + 360) % 360 - 180); }

  /* A soft radial sprite per tier: one drawImage instead of one gradient per
     marker per frame, which is what keeps a month of events smooth. */
  function makeGlows(theme) {
    return theme.tiers.map(function (col) {
      const c = document.createElement('canvas'); c.width = c.height = 64;
      const g = c.getContext('2d'), grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
      grd.addColorStop(0, rgba(col, 0.95)); grd.addColorStop(0.22, rgba(col, 0.5));
      grd.addColorStop(0.55, rgba(col, 0.14)); grd.addColorStop(1, rgba(col, 0));
      g.fillStyle = grd; g.fillRect(0, 0, 64, 64);
      return c;
    });
  }

  /* One event marker: glow, a ring in the surface colour so overlapping
     markers stay distinct, then the body. `a` is overall opacity. */
  function drawMarker(ctx, x, y, s, a, pop, view, time) {
    const th = view.theme, col = th.tiers[s.tier];
    const recent = s.q.timeMs != null && Date.now() - s.q.timeMs < 3600e3;
    const r = s.r * pop * (recent && !FX.reducedMotion() ? 1 + 0.12 * Math.sin(time * 3.2 + s.phase) : 1);
    if (r < 0.3 || a < 0.02) return;
    const gr = r * (s.tier >= 3 ? 4.6 : 3.5);
    ctx.globalAlpha = a * (th.dark ? 0.6 : 0.42);
    ctx.globalCompositeOperation = th.dark ? 'lighter' : 'source-over';
    ctx.drawImage(view.glows[s.tier], x - gr, y - gr, gr * 2, gr * 2);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = a;
    if (r > 2.4) { ctx.beginPath(); ctx.arc(x, y, r + 1.7, 0, TAU); ctx.fillStyle = view.ringColor; ctx.fill(); }
    ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fillStyle = rgba(col, 1); ctx.fill();
    if (s.tier >= 4) { ctx.beginPath(); ctx.arc(x, y, r * 0.42, 0, TAU); ctx.fillStyle = 'rgba(255,255,255,0.92)'; ctx.fill(); }
    ctx.globalAlpha = 1;
  }

  /* Targeting brackets around the selected event; they lock on with a snap. */
  function drawReticle(ctx, x, y, r, view, time, since) {
    const th = view.theme, p = clamp((time - since) / 0.45, 0, 1);
    const d = (r + 11) * (FX.reducedMotion() ? 1 : 1 + (1 - ease.outBack(p)) * 1.4), len = 6 + r * 0.25;
    ctx.save(); ctx.translate(x, y); if (!FX.reducedMotion()) ctx.rotate(time * 0.5);
    ctx.strokeStyle = rgba(th.ink, 0.95); ctx.lineWidth = 1.6; ctx.lineCap = 'round';
    for (let i = 0; i < 4; i++) {
      ctx.save(); ctx.rotate(i * Math.PI / 2);
      ctx.beginPath(); ctx.moveTo(d, -len); ctx.lineTo(d, 0); ctx.lineTo(d, len); ctx.stroke();
      ctx.restore();
    }
    ctx.restore();
  }

  /* ---------------------------------------------------------------- globe */

  class GlobeView {
    constructor(canvas, layer) {
      this.canvas = canvas; this.ctx = canvas.getContext('2d'); this.layer = layer;
      this.proj = new MC.Ortho();
      this.lat0 = 18; this.lon0 = 15; this.zoom = 1;
      this.w = 0; this.h = 0; this.dpr = 1; this.R = 100; this.cx = 0; this.cy = 0;
      this.dots = null; this.coast = null; this.grat = null; this.landAlpha = 0;
      this.theme = null; this.glows = null; this.ringColor = '#000';
      this.velLon = 0; this.velLat = 0; this.dragging = false; this.idleFor = 0;
      this.spin = true; this.hold = false; this.dayNight = true; this.fly = null;
      this.home = null; this.arc = null; this.regionVec = null;
      this.tmp = [0, 0, 0];
      this.resize();
    }
    setTheme(theme) { this.theme = theme; this.glows = makeGlows(theme); this.ringColor = rgba(theme.dark ? theme.oceanB : theme.surface, 1); }
    setLand(land) {
      this.dots = land.points(DOT_LATTICE);
      this.coast = land.runsXYZ();
      this.grat = [];
      for (let lat = -60; lat <= 60; lat += 30) {
        const line = []; for (let lon = -180; lon <= 180; lon += 6) line.push(MC.vec(lat, lon)); this.grat.push(line);
      }
      for (let lon = -180; lon < 180; lon += 30) {
        const line = []; for (let lat = -84; lat <= 84; lat += 6) line.push(MC.vec(lat, lon)); this.grat.push(line);
      }
      this.landAlpha = 0;
    }
    resize() {
      const f = FX.fit(this.canvas); this.w = f.w; this.h = f.h; this.dpr = f.dpr;
      this.cx = f.w / 2; this.cy = f.h / 2; this.updateRadius();
    }
    updateRadius() { this.R = Math.min(this.w, this.h) * 0.44 * this.zoom; }

    flyTo(lat, lon, zoom, dur) {
      const z1 = zoom == null ? this.zoom : clamp(zoom, 0.75, 3.2);
      if (FX.reducedMotion() || dur === 0) { this.lat0 = clamp(lat, -85, 85); this.lon0 = lon; this.zoom = z1; this.fly = null; this.updateRadius(); return; }
      this.fly = { t0: null, dur: dur || 1.3, lat: this.lat0, lon: this.lon0, zoom: this.zoom,
                   lat1: clamp(lat, -85, 85), lon1: shortestLon(this.lon0, lon), zoom1: z1 };
      this.velLon = this.velLat = 0;
    }
    /* Frame a lon/lat box: point at its centre, zoom to its angular size. */
    flyToBounds(b, dur) {
      const lat = (b[0] + b[1]) / 2, lon = (b[2] + b[3]) / 2;
      const span = Math.max(b[1] - b[0], (b[3] - b[2]) * Math.cos(lat * D2R));
      this.flyTo(lat, MC.wrapLon(lon), clamp(70 / Math.max(10, span), 0.9, 2.6), dur);
    }
    update(dt) {
      if (this.landAlpha < 1 && this.dots) this.landAlpha = Math.min(1, this.landAlpha + dt / 1.4);
      if (this.fly) {
        const f = this.fly; if (f.t0 == null) f.t0 = this.layer.time;
        const p = clamp((this.layer.time - f.t0) / f.dur, 0, 1), e = ease.inOutCubic(p);
        this.lat0 = lerp(f.lat, f.lat1, e); this.lon0 = lerp(f.lon, f.lon1, e);
        this.zoom = lerp(f.zoom, f.zoom1, e) - 0.16 * Math.sin(Math.PI * p);      // pull back mid-flight
        this.updateRadius(); if (p >= 1) this.fly = null;
        return;
      }
      if (!this.dragging) {
        if (Math.abs(this.velLon) > 0.01 || Math.abs(this.velLat) > 0.01) {
          this.lon0 += this.velLon * dt; this.lat0 = clamp(this.lat0 + this.velLat * dt, -85, 85);
          const k = Math.pow(0.04, dt); this.velLon *= k; this.velLat *= k;
        } else if (this.spin && !this.hold && !FX.reducedMotion() && this.idleFor > 2.5) {
          this.lon0 -= 5 * dt;                                     // Earth turns eastward
        }
        this.idleFor += dt;
      }
    }
    touch() { this.idleFor = 0; }

    /* World position -> screen, or null if on the far side. */
    place(s) {
      const o = this.tmp; this.proj.rot(s.v[0], s.v[1], s.v[2], o);
      if (o[2] <= 0.02) return null;
      return { x: this.cx + this.R * o[0], y: this.cy - this.R * o[1], z: o[2] };
    }
    placeLL(lat, lon) { const v = MC.vec(lat, lon), o = [0, 0, 0]; this.proj.rot(v[0], v[1], v[2], o); return o[2] <= 0 ? null : { x: this.cx + this.R * o[0], y: this.cy - this.R * o[1], z: o[2] }; }
    screenToLatLon(px, py) {
      const x = (px - this.cx) / this.R, y = (this.cy - py) / this.R, r2 = x * x + y * y;
      if (r2 > 1) return null;
      return this.proj.unrot(x, y, Math.sqrt(1 - r2));
    }
    drag(dx, dy) {
      const k = R2D / this.R;
      this.lon0 -= dx * k; this.lat0 = clamp(this.lat0 + dy * k, -85, 85);
    }
    zoomBy(f) { this.zoom = clamp(this.zoom * f, 0.75, 3.2); this.updateRadius(); }

    /* Stroke a polyline of unit vectors, visible parts only; segments that
       cross the horizon are cut where they meet it. */
    pathLine(ctx, get, n) {
      const o = this.tmp, R = this.R, cx = this.cx, cy = this.cy, proj = this.proj;
      let px = 0, py = 0, pz = 0, pvis = false, drawing = false;
      for (let i = 0; i < n; i++) {
        get(i, o); proj.rot(o[0], o[1], o[2], o);
        const x = o[0], y = o[1], z = o[2], vis = z > 0;
        if (i > 0) {
          if (vis && pvis) { if (!drawing) { ctx.moveTo(cx + R * px, cy - R * py); drawing = true; } ctx.lineTo(cx + R * x, cy - R * y); }
          else if (vis !== pvis) {
            const t = pz / (pz - z), hx = px + t * (x - px), hy = py + t * (y - py), l = Math.hypot(hx, hy) || 1;
            if (pvis) { if (!drawing) ctx.moveTo(cx + R * px, cy - R * py); ctx.lineTo(cx + R * hx / l, cy - R * hy / l); drawing = false; }
            else { ctx.moveTo(cx + R * hx / l, cy - R * hy / l); ctx.lineTo(cx + R * x, cy - R * y); drawing = true; }
          } else drawing = false;
        }
        px = x; py = y; pz = z; pvis = vis;
      }
    }

    draw(now, sel) {
      const ctx = this.ctx, th = this.theme; if (!th) return;
      const R = this.R, cx = this.cx, cy = this.cy, layer = this.layer, time = layer.time;
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      ctx.clearRect(0, 0, this.w, this.h);
      this.proj.set(this.lat0, this.lon0);
      const o = this.tmp;

      // atmosphere
      const atm = ctx.createRadialGradient(cx, cy, R * 0.96, cx, cy, R * 1.32);
      atm.addColorStop(0, rgba(th.accent, th.dark ? 0.34 : 0.22)); atm.addColorStop(0.35, rgba(th.accent, th.dark ? 0.1 : 0.07));
      atm.addColorStop(1, rgba(th.accent, 0));
      ctx.fillStyle = atm; ctx.beginPath(); ctx.arc(cx, cy, R * 1.32, 0, TAU); ctx.fill();
      // ocean
      const sea = ctx.createRadialGradient(cx - R * 0.38, cy - R * 0.42, R * 0.1, cx, cy, R * 1.04);
      sea.addColorStop(0, rgba(th.oceanA, 1)); sea.addColorStop(1, rgba(th.oceanB, 1));
      ctx.fillStyle = sea; ctx.beginPath(); ctx.arc(cx, cy, R, 0, TAU); ctx.fill();
      ctx.lineWidth = 1.2; ctx.strokeStyle = rgba(th.accent, th.dark ? 0.4 : 0.35); ctx.stroke();

      ctx.save(); ctx.beginPath(); ctx.arc(cx, cy, R, 0, TAU); ctx.clip();

      // graticule
      if (this.grat) {
        ctx.beginPath(); ctx.lineWidth = 1; ctx.strokeStyle = rgba(th.grid, th.dark ? 0.1 : 0.14);
        this.grat.forEach(line => this.pathLine(ctx, (i, out) => { const v = line[i]; out[0] = v[0]; out[1] = v[1]; out[2] = v[2]; }, line.length));
        ctx.stroke();
      }

      // land as dots, dimmed on the night side
      if (this.dots && this.landAlpha > 0) {
        const d = this.dots, n = d.length, B = 6;
        const sun = MC.subsolar(Date.now()), sv = MC.vec(sun.lat, sun.lon), useSun = this.dayNight;
        const s = this.proj, size = Math.max(1.3, R / 175);
        const paths = []; for (let b = 0; b < B; b++) paths.push([]);
        for (let i = 0; i < n; i += 3) {
          s.rot(d[i], d[i + 1], d[i + 2], o);
          const z = o[2]; if (z <= 0.03) continue;
          let a = 0.3 + 0.7 * Math.pow(z, 0.7);
          if (useSun) { const nd = d[i] * sv[0] + d[i + 1] * sv[1] + d[i + 2] * sv[2]; a *= 0.3 + 0.7 * ease.smoothstep(-0.14, 0.26, nd); }
          const b = Math.min(B - 1, (a * B) | 0), k = size * (0.7 + 0.3 * z);
          paths[b].push(cx + R * o[0] - k / 2, cy - R * o[1] - k / 2, k);
        }
        for (let b = 0; b < B; b++) {
          const p = paths[b]; if (!p.length) continue;
          ctx.fillStyle = rgba(th.land, ((b + 0.5) / B) * this.landAlpha * (th.dark ? 0.95 : 0.85));
          ctx.beginPath(); for (let i = 0; i < p.length; i += 3) ctx.rect(p[i], p[i + 1], p[i + 2], p[i + 2]);
          ctx.fill();
        }
      }
      if (this.coast && this.landAlpha > 0) {
        ctx.beginPath(); ctx.lineWidth = 0.9; ctx.strokeStyle = rgba(th.coast, (th.dark ? 0.34 : 0.4) * this.landAlpha);
        this.coast.forEach(run => this.pathLine(ctx, (i, out) => { out[0] = run[i * 3]; out[1] = run[i * 3 + 1]; out[2] = run[i * 3 + 2]; }, run.length / 3));
        ctx.stroke();
      }

      // the searched area
      if (this.regionVec) this.drawRegion(ctx, th);

      // shockwaves, on the surface
      for (let i = 0; i < layer.list.length; i++) {
        const s = layer.list[i]; if (!s.ripples.length || s.appear < 0.05 || !layer.visible(s)) continue;
        for (const rp of s.ripples) {
          const age = time - rp.t0; if (age < 0) continue;
          const p = age / rp.dur, theta = MC.shockDegrees(s.q.mag) * D2R * rp.scale * ease.outCubic(p);
          const alpha = Math.pow(1 - p, 1.5) * (rp.kind === 'shock' ? 0.95 : 0.55) * s.fade;
          if (alpha < 0.02) continue;
          ctx.beginPath(); ctx.lineWidth = 0.8 + 2.2 * (1 - p); ctx.strokeStyle = rgba(th.tiers[s.tier], alpha);
          this.pathLine(ctx, (k, out) => MC.onCircle(s.v, s.t, theta, k * (TAU / 64), out), 65);
          ctx.stroke();
        }
      }

      // arc from home to the selected event
      if (this.arc) this.drawArc(ctx, th, time);

      // markers
      for (let i = 0; i < layer.list.length; i++) {
        const s = layer.list[i]; if (!layer.visible(s)) continue;
        const pt = this.place(s); if (!pt) continue;
        const ageH = s.q.timeMs ? (Date.now() - s.q.timeMs) / 3.6e6 : 99;
        const a = s.fade * s.appear * (0.52 + 0.48 * Math.exp(-ageH / 26)) * ease.smoothstep(0.02, 0.3, pt.z);
        drawMarker(ctx, pt.x, pt.y, s, a, ease.outBack(clamp(s.appear, 0, 1)), this, time);
      }
      if (this.home) {
        const pt = this.placeLL(this.home.lat, this.home.lon);
        if (pt) this.drawHome(ctx, pt.x, pt.y, time);
      }
      if (sel) { const s = layer.get(sel.id); const pt = s && this.place(s); if (pt) drawReticle(ctx, pt.x, pt.y, s.r, this, time, sel.since); }
      const hov = layer.hoverId && layer.hoverId !== (sel && sel.id) ? layer.get(layer.hoverId) : null;
      if (hov) { const pt = this.place(hov); if (pt) { ctx.beginPath(); ctx.arc(pt.x, pt.y, hov.r + 5, 0, TAU); ctx.lineWidth = 1.5; ctx.strokeStyle = rgba(th.ink, 0.9); ctx.stroke(); } }
      ctx.restore();

      // rim light over everything
      const rim = ctx.createRadialGradient(cx, cy, R * 0.82, cx, cy, R);
      rim.addColorStop(0, rgba(th.oceanB, 0)); rim.addColorStop(1, rgba(th.oceanB, th.dark ? 0.55 : 0.18));
      ctx.fillStyle = rim; ctx.beginPath(); ctx.arc(cx, cy, R, 0, TAU); ctx.fill();
    }

    drawHome(ctx, x, y, time) {
      const th = this.theme, p = (time % 2.4) / 2.4;
      ctx.lineWidth = 1.4; ctx.strokeStyle = rgba(th.ink, 0.9 * (1 - p)); ctx.beginPath(); ctx.arc(x, y, 5 + p * 16, 0, TAU); ctx.stroke();
      ctx.strokeStyle = rgba(th.ink, 1); ctx.lineWidth = 1.8;
      ctx.beginPath(); ctx.moveTo(x - 6, y); ctx.lineTo(x + 6, y); ctx.moveTo(x, y - 6); ctx.lineTo(x, y + 6); ctx.stroke();
    }
    drawRegion(ctx, th) {
      ctx.lineWidth = 1.6; ctx.strokeStyle = rgba(th.accent, 0.85); ctx.fillStyle = rgba(th.accent, 0.07);
      this.regionVec.forEach(ring => {
        ctx.beginPath(); this.pathLine(ctx, (i, out) => { const v = ring[i]; out[0] = v[0]; out[1] = v[1]; out[2] = v[2]; }, ring.length); ctx.stroke();
      });
    }
    /* An arc that lifts off the surface between two points, drawing itself. */
    drawArc(ctx, th, time) {
      const a = this.arc, p = clamp((time - a.since) / 0.9, 0, 1), e = ease.outCubic(p), n = 48;
      const dot = clamp(a.from[0] * a.to[0] + a.from[1] * a.to[1] + a.from[2] * a.to[2], -1, 1), om = Math.acos(dot);
      if (om < 1e-4) return;
      const so = Math.sin(om), o = this.tmp;
      ctx.beginPath(); ctx.lineWidth = 1.6; ctx.strokeStyle = rgba(th.ink, 0.75);
      let drawing = false;
      for (let i = 0; i <= Math.floor(n * e); i++) {
        const t = i / n, k0 = Math.sin((1 - t) * om) / so, k1 = Math.sin(t * om) / so, lift = 1 + 0.22 * Math.sin(Math.PI * t) * Math.min(1, om);
        const vx = (a.from[0] * k0 + a.to[0] * k1) * lift, vy = (a.from[1] * k0 + a.to[1] * k1) * lift, vz = (a.from[2] * k0 + a.to[2] * k1) * lift;
        this.proj.rot(vx, vy, vz, o);
        const behind = o[2] < 0 && Math.hypot(o[0], o[1]) < 1;       // hidden by the planet
        if (behind) { drawing = false; continue; }
        const x = this.cx + this.R * o[0], y = this.cy - this.R * o[1];
        if (!drawing) { ctx.moveTo(x, y); drawing = true; } else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    setRegion(boxes) {
      this.regionVec = !boxes ? null : boxes.map(b => {
        const ring = [], lo0 = b[2], lo1 = b[3], steps = 24;
        for (let i = 0; i <= steps; i++) ring.push(MC.vec(b[0], lo0 + (lo1 - lo0) * i / steps));
        for (let i = 0; i <= steps; i++) ring.push(MC.vec(b[0] + (b[1] - b[0]) * i / steps, lo1));
        for (let i = 0; i <= steps; i++) ring.push(MC.vec(b[1], lo1 - (lo1 - lo0) * i / steps));
        for (let i = 0; i <= steps; i++) ring.push(MC.vec(b[1] - (b[1] - b[0]) * i / steps, lo0));
        return ring;
      });
    }
    setCircle(center, radiusKm) {
      if (!center) { this.regionVec = null; return; }
      const v = MC.vec(center[0], center[1]), t = MC.tangents(v), theta = radiusKm / 6371.0088, ring = [], p = [0, 0, 0];
      for (let i = 0; i <= 72; i++) ring.push(MC.onCircle(v, t, theta, i * TAU / 72, p).slice());
      this.regionVec = [ring];
    }
  }

  /* ------------------------------------------------------------ flat map */

  class FlatView {
    constructor(canvas, layer) {
      this.canvas = canvas; this.ctx = canvas.getContext('2d'); this.layer = layer;
      this.w = 0; this.h = 0; this.dpr = 1;
      this.lon = 10; this.lat = 18; this.scale = 120;
      this.minScale = 60; this.maxScale = 14000;
      this.land = null; this.theme = null; this.glows = null; this.ringColor = '#000';
      this.fly = null; this.home = null; this.arc = null; this.regions = null; this.circle = null;
      this.bg = document.createElement('canvas'); this.bgKey = '';
      this.resize(); this.reset(true);
    }
    setTheme(theme) { this.theme = theme; this.glows = makeGlows(theme); this.ringColor = rgba(theme.dark ? theme.oceanB : theme.surface, 1); this.bgKey = ''; }
    setLand(land) { this.land = land; this.bgKey = ''; }
    resize() {
      const f = FX.fit(this.canvas); this.w = f.w; this.h = f.h; this.dpr = f.dpr;
      this.minScale = Math.max(this.w / TAU, this.h / 6.4);
      this.scale = clamp(this.scale, this.minScale, this.maxScale); this.bgKey = '';
    }
    reset(instant) {
      const s = Math.max(this.minScale, this.h / 3.3);
      if (instant) { this.lon = 10; this.lat = 18; this.scale = s; this.fly = null; } else this.flyTo(18, 10, s);
    }
    /* World (lon, lat) <-> screen. `scale` is pixels per radian. */
    sx(lon) { return this.w / 2 + (lon - this.lon) * D2R * this.scale; }
    sy(lat) { return this.h / 2 - (MC.mercY(lat) - MC.mercY(this.lat)) * this.scale; }
    toLonLat(px, py) { return [this.lon + (px - this.w / 2) / this.scale * R2D, MC.mercLat(MC.mercY(this.lat) - (py - this.h / 2) / this.scale)]; }
    /* Nearest copy of a longitude to the view centre, so the world repeats. */
    wrapNear(lon) { return lon + 360 * Math.round((this.lon - lon) / 360); }
    place(s) {
      const x = this.sx(this.wrapNear(s.lon)), y = this.sy(s.lat);
      if (x < -30 || x > this.w + 30 || y < -30 || y > this.h + 30) return null;
      return { x, y, z: 1 };
    }
    placeLL(lat, lon) { const x = this.sx(this.wrapNear(lon)), y = this.sy(lat); return { x, y, z: 1 }; }

    clampView() {
      this.scale = clamp(this.scale, this.minScale, this.maxScale);
      const halfH = this.h / 2 / this.scale, yMax = MC.mercY(84) - halfH * 0.85, yMin = MC.mercY(-80) + halfH * 0.85;
      const yc = clamp(MC.mercY(this.lat), Math.min(yMin, yMax), Math.max(yMin, yMax));
      this.lat = MC.mercLat(yc); this.lon = MC.wrapLon(this.lon);
    }
    flyTo(lat, lon, scale, dur) {
      const s1 = clamp(scale == null ? this.scale : scale, this.minScale, this.maxScale);
      if (FX.reducedMotion() || dur === 0) { this.lat = lat; this.lon = lon; this.scale = s1; this.fly = null; this.clampView(); return; }
      this.fly = { t0: null, dur: dur || 1.2, lat: this.lat, lon: this.lon, scale: this.scale,
                   lat1: lat, lon1: shortestLon(this.lon, lon), scale1: s1 };
    }
    flyToBounds(b, dur) {
      const f = MC.fitFlat(b, this.w, this.h, 56, { min: this.minScale, max: this.maxScale });
      this.flyTo(f.lat, f.lon, f.scale, dur);
    }
    update(dt) {
      if (!this.fly) return;
      const f = this.fly; if (f.t0 == null) f.t0 = this.layer.time;
      const p = clamp((this.layer.time - f.t0) / f.dur, 0, 1), e = ease.inOutCubic(p);
      this.lat = lerp(f.lat, f.lat1, e); this.lon = lerp(f.lon, f.lon1, e);
      this.scale = Math.exp(lerp(Math.log(f.scale), Math.log(f.scale1), e)) * (1 - 0.1 * Math.sin(Math.PI * p));
      this.clampView(); if (p >= 1) this.fly = null;
    }
    touch() {}
    drag(dx, dy) {
      const y = MC.mercY(this.lat) + dy / this.scale;
      this.lon -= dx / this.scale * R2D; this.lat = MC.mercLat(y); this.fly = null; this.clampView();
    }
    zoomBy(f, px, py) {
      px = px == null ? this.w / 2 : px; py = py == null ? this.h / 2 : py;
      const before = this.toLonLat(px, py);
      this.scale = clamp(this.scale * f, this.minScale, this.maxScale); this.fly = null;
      const y = MC.mercY(before[1]) + (py - this.h / 2) / this.scale;       // keep the point under the cursor
      this.lon = before[0] - (px - this.w / 2) / this.scale * R2D; this.lat = MC.mercLat(y); this.clampView();
    }
    screenToLatLon(px, py) { const p = this.toLonLat(px, py); return [p[1], MC.wrapLon(p[0])]; }

    /* Ocean, graticule and land change only when the camera does, so they
       are cached and redrawn only then. */
    drawBase(th) {
      const key = [this.w, this.h, this.dpr, this.lon.toFixed(3), this.lat.toFixed(3), this.scale.toFixed(2), th.dark, !!this.land].join('|');
      if (key === this.bgKey) return;
      this.bgKey = key;
      const b = this.bg; b.width = this.canvas.width; b.height = this.canvas.height;
      const g = b.getContext('2d'); g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      const sea = g.createLinearGradient(0, 0, 0, this.h);
      sea.addColorStop(0, rgba(th.oceanA, 1)); sea.addColorStop(1, rgba(th.oceanB, 1));
      g.fillStyle = sea; g.fillRect(0, 0, this.w, this.h);

      // graticule: hairlines, finer as you zoom
      const step = this.scale > 4000 ? 2 : this.scale > 1500 ? 5 : this.scale > 500 ? 10 : 30;
      g.lineWidth = 1; g.strokeStyle = rgba(th.grid, th.dark ? 0.1 : 0.14); g.beginPath();
      const left = this.lon - this.w / 2 / this.scale * R2D, right = this.lon + this.w / 2 / this.scale * R2D;
      for (let lo = Math.floor(left / step) * step; lo <= right; lo += step) { const x = Math.round(this.sx(lo)) + 0.5; g.moveTo(x, 0); g.lineTo(x, this.h); }
      for (let la = -80; la <= 80; la += step) { const y = Math.round(this.sy(la)) + 0.5; if (y >= 0 && y <= this.h) { g.moveTo(0, y); g.lineTo(this.w, y); } }
      g.stroke();

      if (this.land) {
        const worldW = TAU * this.scale, lo0 = Math.floor((left + 180) / 360), lo1 = Math.floor((right + 180) / 360);
        g.fillStyle = rgba(th.landFill, th.dark ? 0.16 : 0.2); g.strokeStyle = rgba(th.coast, th.dark ? 0.5 : 0.55); g.lineWidth = 1; g.lineJoin = 'round';
        for (let copy = lo0 - 1; copy <= lo1 + 1; copy++) {           // one extra each side: shapes now overhang the seam
          const dx = copy * worldW;
          g.beginPath();
          this.land.polys.forEach(poly => poly.forEach(ring => {
            for (let i = 0; i < ring.length; i++) {
              const x = this.sx(ring[i][0]) + dx, y = this.sy(ring[i][1]);
              if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
            }
            g.closePath();
          }));
          g.fill('evenodd');
          g.beginPath();
          this.land.runs.forEach(run => run.forEach((p, i) => { const x = this.sx(p[0]) + dx, y = this.sy(p[1]); if (i === 0) g.moveTo(x, y); else g.lineTo(x, y); }));
          g.stroke();
        }
      }
    }

    draw(now, sel) {
      const ctx = this.ctx, th = this.theme; if (!th) return;
      const layer = this.layer, time = layer.time;
      ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      this.drawBase(th); ctx.drawImage(this.bg, 0, 0);
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

      if (this.regions) this.drawRegions(ctx, th);

      const zoomK = clamp(Math.pow(this.scale / this.minScale, 0.18), 1, 2.4);        // markers swell a little as you zoom
      for (let i = 0; i < layer.list.length; i++) {
        const s = layer.list[i]; if (!s.ripples.length || s.appear < 0.05 || !layer.visible(s)) continue;
        const pt = this.place(s); if (!pt) continue;
        for (const rp of s.ripples) {
          const age = time - rp.t0; if (age < 0) continue;
          const p = age / rp.dur, alpha = Math.pow(1 - p, 1.5) * (rp.kind === 'shock' ? 0.95 : 0.55) * s.fade;
          if (alpha < 0.02) continue;
          const rad = (14 + MC.shockDegrees(s.q.mag) * 3.4) * rp.scale * ease.outCubic(p) * Math.sqrt(zoomK);
          ctx.beginPath(); ctx.lineWidth = 0.8 + 2.2 * (1 - p); ctx.strokeStyle = rgba(th.tiers[s.tier], alpha);
          ctx.arc(pt.x, pt.y, rad, 0, TAU); ctx.stroke();
        }
      }
      if (this.arc) this.drawArc(ctx, th, time);
      for (let i = 0; i < layer.list.length; i++) {
        const s = layer.list[i]; if (!layer.visible(s)) continue;
        const pt = this.place(s); if (!pt) continue;
        const ageH = s.q.timeMs ? (Date.now() - s.q.timeMs) / 3.6e6 : 99;
        const a = s.fade * s.appear * (0.55 + 0.45 * Math.exp(-ageH / 26));
        drawMarker(ctx, pt.x, pt.y, s, a, ease.outBack(clamp(s.appear, 0, 1)) * Math.sqrt(zoomK), this, time);
      }
      if (this.home) {
        const pt = this.placeLL(this.home.lat, this.home.lon), p = (time % 2.4) / 2.4;
        ctx.lineWidth = 1.4; ctx.strokeStyle = rgba(th.ink, 0.9 * (1 - p)); ctx.beginPath(); ctx.arc(pt.x, pt.y, 5 + p * 16, 0, TAU); ctx.stroke();
        ctx.strokeStyle = rgba(th.ink, 1); ctx.lineWidth = 1.8;
        ctx.beginPath(); ctx.moveTo(pt.x - 6, pt.y); ctx.lineTo(pt.x + 6, pt.y); ctx.moveTo(pt.x, pt.y - 6); ctx.lineTo(pt.x, pt.y + 6); ctx.stroke();
      }
      if (sel) { const s = layer.get(sel.id); const pt = s && this.place(s); if (pt) drawReticle(ctx, pt.x, pt.y, s.r * Math.sqrt(zoomK), this, time, sel.since); }
      const hov = layer.hoverId && layer.hoverId !== (sel && sel.id) ? layer.get(layer.hoverId) : null;
      if (hov) { const pt = this.place(hov); if (pt) { ctx.beginPath(); ctx.arc(pt.x, pt.y, hov.r * Math.sqrt(zoomK) + 5, 0, TAU); ctx.lineWidth = 1.5; ctx.strokeStyle = rgba(th.ink, 0.9); ctx.stroke(); } }
    }
    drawRegions(ctx, th) {
      ctx.lineWidth = 1.6; ctx.strokeStyle = rgba(th.accent, 0.85); ctx.fillStyle = rgba(th.accent, 0.07);
      this.regions.forEach(b => {
        const lo0 = this.wrapNear((b[2] + b[3]) / 2) - (b[2] + b[3]) / 2;
        const x0 = this.sx(b[2] + lo0), x1 = this.sx(b[3] + lo0), y0 = this.sy(b[1]), y1 = this.sy(b[0]);
        ctx.beginPath(); ctx.rect(x0, y0, x1 - x0, y1 - y0); ctx.fill(); ctx.stroke();
      });
      if (this.circle) {
        const c = this.circle, v = MC.vec(c.center[0], c.center[1]), t = MC.tangents(v), theta = c.km / 6371.0088, p = [0, 0, 0];
        ctx.beginPath();
        for (let i = 0; i <= 96; i++) {
          MC.onCircle(v, t, theta, i * TAU / 96, p);
          const ll = MC.latLon(p), x = this.sx(this.wrapNear(ll[1])), y = this.sy(ll[0]);
          if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.closePath(); ctx.fill(); ctx.stroke();
      }
    }
    drawArc(ctx, th, time) {
      const a = this.arc, p = clamp((time - a.since) / 0.9, 0, 1), e = ease.outCubic(p), n = 64;
      const dot = clamp(a.from[0] * a.to[0] + a.from[1] * a.to[1] + a.from[2] * a.to[2], -1, 1), om = Math.acos(dot);
      if (om < 1e-4) return;
      const so = Math.sin(om);
      ctx.beginPath(); ctx.lineWidth = 1.6; ctx.strokeStyle = rgba(th.ink, 0.7);
      let lastX = null;
      for (let i = 0; i <= Math.floor(n * e); i++) {
        const t = i / n, k0 = Math.sin((1 - t) * om) / so, k1 = Math.sin(t * om) / so;
        const ll = MC.latLon([a.from[0] * k0 + a.to[0] * k1, a.from[1] * k0 + a.to[1] * k1, a.from[2] * k0 + a.to[2] * k1]);
        const x = this.sx(this.wrapNear(ll[1])), y = this.sy(ll[0]);
        if (lastX == null || Math.abs(x - lastX) > this.w / 2) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        lastX = x;
      }
      ctx.stroke();
    }
    setRegion(boxes) { this.regions = boxes; this.circle = null; }
    setCircle(center, km) { this.circle = center ? { center, km } : null; this.regions = null; }
  }

  /* ---------------------------------------------------------------- stage */

  class Stage {
    constructor(o) {
      this.el = o.el;
      this.layer = new MC.EventLayer();
      this.globe = new GlobeView(o.globeCanvas, this.layer);
      this.flat = new FlatView(o.flatCanvas, this.layer);
      this.mode = 'globe'; this.modeChangedAt = -10;
      this.onHover = o.onHover || (() => {}); this.onSelect = o.onSelect || (() => {});
      this.onTick = o.onTick || (() => {});
      this.sel = null; this.visible = true; this.pointers = new Map(); this.hovering = false; this.regionActive = false;
      this.pending = null; this.moved = 0; this.last = null;
      this.loop = new FX.Loop((dt, now) => this.frame(dt, now));
      this.bindPointer(o.pointerEl || this.el);
      if (window.ResizeObserver) { this.ro = new ResizeObserver(() => this.resize()); this.ro.observe(this.el); }
    }
    get view() { return this.mode === 'flat' ? this.flat : this.globe; }
    start() { this.loop.start(); }
    stop() { this.loop.stop(); }
    resize() { this.globe.resize(); this.flat.resize(); }
    setTheme(theme) { this.globe.setTheme(theme); this.flat.setTheme(theme); }
    setLand(land) { this.globe.setLand(land); this.flat.setLand(land); }
    setQuakes(quakes, o) { this.layer.setQuakes(quakes, o); }
    setMode(mode) {
      if (mode === this.mode) return;
      this.mode = mode; this.modeChangedAt = this.layer.time;
      this.layer.hoverId = null;
    }
    setSpin(on) { this.globe.spin = !!on; }
    setDayNight(on) { this.globe.dayNight = !!on; }
    setHome(h) { this.globe.home = h; this.flat.home = h; this.refreshArc(); }
    select(sprite) {
      this.sel = sprite ? { id: sprite.id, since: this.layer.time } : null;
      this.layer.selectedId = sprite ? sprite.id : null;
      this.refreshArc(); this.updateHold();
    }
    /* The globe drifts only when nobody is looking at anything in particular:
       no event selected, no region searched, and the pointer not on the map. */
    updateHold() { this.globe.hold = !!this.sel || this.regionActive || this.hovering; }
    refreshArc() {
      const home = this.globe.home, s = this.sel && this.layer.get(this.sel.id);
      const arc = home && s ? { from: MC.vec(home.lat, home.lon), to: s.v, since: this.layer.time } : null;
      this.globe.arc = arc; this.flat.arc = arc;
    }
    /* Bring an event to the middle of whichever map is showing. */
    focusQuake(q, o) {
      o = o || {};
      if (q.lat == null) return;
      if (this.mode === 'globe') this.globe.flyTo(q.lat, q.lon, o.zoom || clamp(this.globe.zoom, 1.3, 1.9), 1.2);
      else this.flat.flyTo(q.lat, q.lon, clamp(this.flat.scale, this.flat.h * 1.6, this.flat.h * 4), 1.2);
    }
    showRegion(boxes, bounds) {
      this.regionActive = true; this.updateHold();
      this.globe.setRegion(boxes); this.flat.setRegion(boxes);
      if (bounds) { this.globe.flyToBounds(bounds, 1.4); this.flat.flyToBounds(bounds, 1.4); }
    }
    showCircle(center, km) {
      this.regionActive = !!center; this.updateHold();
      this.globe.setCircle(center, km); this.flat.setCircle(center, km);
      if (center) { this.globe.flyTo(center[0], center[1], clamp(2200 / km, 1, 2.6) * 0.9, 1.4); this.flat.flyToBounds([center[0] - km / 111, center[0] + km / 111, center[1] - km / (111 * Math.max(0.2, Math.cos(center[0] * D2R))), center[1] + km / (111 * Math.max(0.2, Math.cos(center[0] * D2R)))], 1.4); }
    }
    clearRegion() { this.regionActive = false; this.updateHold(); this.globe.setRegion(null); this.flat.setRegion(null); }
    resetView() { this.globe.flyTo(18, 15, 1, 1.2); this.flat.reset(false); }
    zoomBy(f) { this.view.zoomBy(f); }

    frame(dt, now) {
      if (!this.visible) return;
      this.layer.tick(dt);
      this.globe.update(dt); this.flat.update(dt);
      const fading = this.layer.time - this.modeChangedAt < 0.8;
      if (this.mode === 'globe' || fading) this.globe.draw(now, this.sel);
      if (this.mode === 'flat' || fading) this.flat.draw(now, this.sel);
      this.onTick(dt);
    }

    /* ---- pointer handling: drag, pinch, wheel, hover, click ---- */
    bindPointer(el) {
      const rel = e => { const r = el.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
      const pickAt = p => this.layer.pick(p.x, p.y, s => this.view.place(s), 14);
      el.addEventListener('pointerdown', e => {
        if (e.button !== 0 && e.pointerType === 'mouse') return;
        el.setPointerCapture(e.pointerId);
        const p = rel(e); this.pointers.set(e.pointerId, p);
        this.moved = 0; this.last = p; this.view.touch();
        if (this.pointers.size === 1) { this.view.dragging = true; this.view.fly = null; this.view.velLon = this.view.velLat = 0; }
        this.pinch = this.pointers.size === 2 ? this.pinchDist() : null;
      });
      el.addEventListener('pointermove', e => {
        const p = rel(e);
        if (!this.pointers.has(e.pointerId)) {                         // hover
          this.hoverAt = p; this.hoverEvt = e; if (!this.hoverQueued) { this.hoverQueued = true; requestAnimationFrame(() => { this.hoverQueued = false; this.doHover(); }); }
          return;
        }
        this.pointers.set(e.pointerId, p);
        if (this.pointers.size === 2) {
          const d = this.pinchDist();
          if (this.pinch && d > 0) { this.view.zoomBy(d / this.pinch, (p.x + this.otherPointer(e.pointerId).x) / 2, (p.y + this.otherPointer(e.pointerId).y) / 2); }
          this.pinch = d; this.moved += 10; return;
        }
        const dx = p.x - this.last.x, dy = p.y - this.last.y; this.moved += Math.abs(dx) + Math.abs(dy);
        if (this.moved > 4) {
          this.view.drag(dx, dy); this.view.touch();
          if (this.mode === 'globe') { this.view.velLon = -dx * R2D / this.view.R * 60; this.view.velLat = dy * R2D / this.view.R * 60; }
          this.onHover(null);
        }
        this.last = p;
      });
      const end = e => {
        if (!this.pointers.has(e.pointerId)) return;
        const p = rel(e), wasClick = this.moved <= 4 && this.pointers.size === 1;
        this.pointers.delete(e.pointerId);
        if (this.pointers.size === 0) { this.view.dragging = false; if (wasClick && e.type === 'pointerup') { const s = pickAt(p); this.onSelect(s); } }
        this.pinch = null;
        if (this.pointers.size === 1) { this.last = Array.from(this.pointers.values())[0]; this.moved = 10; }
      };
      el.addEventListener('pointerup', end); el.addEventListener('pointercancel', end);
      el.addEventListener('pointerenter', e => { if (e.pointerType === 'mouse') { this.hovering = true; this.updateHold(); } });
      el.addEventListener('pointerleave', () => { this.hovering = false; this.updateHold(); this.layer.hoverId = null; this.onHover(null); });
      el.addEventListener('wheel', e => {
        e.preventDefault(); const p = rel(e);
        this.view.zoomBy(Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0016)), p.x, p.y); this.view.touch();
      }, { passive: false });
      el.addEventListener('dblclick', e => {
        const p = rel(e), ll = this.view.screenToLatLon(p.x, p.y);
        if (!ll) return;
        if (this.mode === 'globe') this.globe.flyTo(ll[0], ll[1], this.globe.zoom * 1.5, 0.9);
        else this.flat.flyTo(ll[0], ll[1], this.flat.scale * 2, 0.9);
      });
    }
    pinchDist() { const a = Array.from(this.pointers.values()); return a.length < 2 ? 0 : Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y); }
    otherPointer(id) { for (const [k, v] of this.pointers) if (k !== id) return v; return { x: 0, y: 0 }; }
    doHover() {
      if (this.view.dragging) return;
      if (this.view.fly) {                                   // the map is moving under the pointer: nothing to point at
        if (this.layer.hoverId) { this.layer.hoverId = null; this.onHover(null); }
        return;
      }
      const p = this.hoverAt, s = this.layer.pick(p.x, p.y, q => this.view.place(q), 14);
      const id = s ? s.id : null;
      if (id !== this.layer.hoverId) {
        this.layer.hoverId = id;
        const pt = s && this.view.place(s);
        this.onHover(s, pt);
      }
      this.el.style.cursor = s ? 'pointer' : (this.mode === 'globe' ? 'grab' : 'grab');
    }
  }

  return { Stage, GlobeView, FlatView, drawMarker };
});
