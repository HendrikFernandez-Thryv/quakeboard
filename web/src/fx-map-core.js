/* Map geometry and the event-sprite engine shared by the globe and the flat
   map. The maths here is pure (no canvas), so it is unit-tested in Node. */
(function (root, factory) {
  var api = factory(root.QBFX || (typeof require === 'function' ? require('./fx-common.js') : null));
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.QBMapCore = api;
})(typeof self !== 'undefined' ? self : globalThis, function (FX) {
  'use strict';

  const D2R = Math.PI / 180, R2D = 180 / Math.PI, TAU = Math.PI * 2;
  const clamp = FX.clamp;

  /* ------------------------------------------------------ sphere geometry */

  /* Unit vector for a coordinate: x toward (0N,0E), y toward (0N,90E), z north. */
  function vec(lat, lon) {
    const la = lat * D2R, lo = lon * D2R, c = Math.cos(la);
    return [c * Math.cos(lo), c * Math.sin(lo), Math.sin(la)];
  }
  function latLon(v) { return [Math.asin(clamp(v[2], -1, 1)) * R2D, Math.atan2(v[1], v[0]) * R2D]; }
  /* East and north tangent vectors at a point, for drawing circles on it. */
  function tangents(v) {
    let ex = -v[1], ey = v[0];
    let l = Math.hypot(ex, ey);
    if (l < 1e-9) { ex = 1; ey = 0; l = 1; }                       // a pole: any east will do
    ex /= l; ey /= l;
    return { east: [ex, ey, 0], north: [-v[2] * ey, v[2] * ex, v[0] * ey - v[1] * ex] };
  }
  /* Point at angular distance `theta` from v along compass direction `beta`. */
  function onCircle(v, t, theta, beta, out) {
    const c = Math.cos(theta), s = Math.sin(theta), cb = Math.cos(beta) * s, sb = Math.sin(beta) * s;
    out[0] = v[0] * c + t.east[0] * cb + t.north[0] * sb;
    out[1] = v[1] * c + t.east[1] * cb + t.north[1] * sb;
    out[2] = v[2] * c + t.east[2] * cb + t.north[2] * sb;
    return out;
  }

  /* Orthographic view centred on (lat0, lon0). rot() takes a world unit
     vector to view space: x right, y up, z toward the viewer (visible if > 0). */
  class Ortho {
    constructor() { this.set(0, 0); }
    set(lat0, lon0) {
      this.lat0 = lat0; this.lon0 = lon0;
      this.sLa = Math.sin(lat0 * D2R); this.cLa = Math.cos(lat0 * D2R);
      this.sLo = Math.sin(lon0 * D2R); this.cLo = Math.cos(lon0 * D2R);
    }
    rot(vx, vy, vz, out) {
      const a = vx * this.cLo + vy * this.sLo;
      out[0] = vy * this.cLo - vx * this.sLo;
      out[1] = this.cLa * vz - this.sLa * a;
      out[2] = this.sLa * vz + this.cLa * a;
      return out;
    }
    /* View-space point on the visible hemisphere back to [lat, lon]. */
    unrot(x, y, z) {
      const vx = -this.sLo * x - this.sLa * this.cLo * y + this.cLa * this.cLo * z;
      const vy = this.cLo * x - this.sLa * this.sLo * y + this.cLa * this.sLo * z;
      const vz = this.cLa * y + this.sLa * z;
      return latLon([vx, vy, vz]);
    }
  }

  /* --------------------------------------------------------------- mercator */

  const MERC_MAX = 85.0511;
  const mercY = lat => Math.log(Math.tan(Math.PI / 4 + clamp(lat, -MERC_MAX, MERC_MAX) * D2R / 2));
  const mercLat = y => (2 * Math.atan(Math.exp(y)) - Math.PI / 2) * R2D;
  const wrapLon = lon => ((((lon + 180) % 360) + 360) % 360) - 180;

  /* Camera {lon, lat, scale} that frames bounds [minLat, maxLat, minLon,
     maxLon] in a w x h view. `scale` is pixels per radian of longitude. */
  function fitFlat(bounds, w, h, pad, limits) {
    const minLat = bounds[0], maxLat = bounds[1], minLon = bounds[2], maxLon = bounds[3];
    pad = pad == null ? 32 : pad;
    const spanX = Math.max(0.5, maxLon - minLon) * D2R;
    const y0 = mercY(minLat), y1 = mercY(maxLat), spanY = Math.max(0.01, y1 - y0);
    let scale = Math.min(Math.max(1, w - pad * 2) / spanX, Math.max(1, h - pad * 2) / spanY);
    if (limits) scale = clamp(scale, limits.min, limits.max);
    return { lon: wrapLon((minLon + maxLon) / 2), lat: mercLat((y0 + y1) / 2), scale };
  }

  /* --------------------------------------------------------------- sprites */

  /* Marker radius in CSS pixels: 4 at M4, growing ~1.75 per magnitude unit. */
  function radiusFor(mag) { return mag == null ? 2.6 : Math.max(2.6, 4 + (mag - 4) * 1.75); }
  /* How far a shockwave travels on the globe, in degrees of arc. */
  function shockDegrees(mag) { return clamp((mag == null ? 3 : mag - 2.5) * 2.6, 4, 28); }

  /* The set of events on the map. It owns each event's entrance, its
     shockwaves and its fade-out; the views only draw what it says. */
  class EventLayer {
    constructor() {
      this.sprites = new Map();
      this.list = [];                 // ascending magnitude: big ones draw on top
      this.time = 0;
      this.clock = null;              // replay cut-off in ms, or null for "all"
      this.selectedId = null;
      this.hoverId = null;
      this.cursorId = null;           // keyboard focus in the list
      this.dirty = false;
    }
    /* Replace the events on show. `fresh` is a Set of ids that just arrived
       (they get a shockwave); `cascade` staggers the entrance on first load. */
    setQuakes(quakes, o) {
      o = o || {};
      const fresh = o.fresh || new Set(), keep = new Set(), t = this.time;
      let index = 0;
      const shocks = o.cascade ? quakes.slice().sort((a, b) => b.magnitude - a.magnitude).slice(0, 48).map(q => q.id) : [];
      const shockSet = new Set(shocks);
      const order = o.cascade ? quakes.slice().sort((a, b) => a.epoch - b.epoch) : quakes;
      order.forEach(q => {
        if (q.lat == null || q.lon == null) return;
        keep.add(q.id);
        let s = this.sprites.get(q.id);
        if (s) { s.q = q; s.dying = false; return; }
        const v = vec(q.lat, q.lon);
        s = {
          q, id: q.id, lat: q.lat, lon: q.lon, v, t: tangents(v), tier: q.tier(), r: radiusFor(q.mag),
          born: t + (o.cascade ? Math.min(1.5, index * 0.018) : 0), appear: 0, fade: 1, dying: false,
          ripples: [], phase: FX.hash01(q.id) * TAU, nextAmbient: t + 2 + FX.hash01(q.id + 'a') * 3,
          shocked: false,
        };
        if (fresh.has(q.id) || shockSet.has(q.id)) s.shockAt = s.born;
        this.sprites.set(q.id, s);
        index++;
      });
      this.sprites.forEach(s => { if (!keep.has(s.id)) s.dying = true; });
      this.dirty = true;
    }
    /* Start a shockwave ring. `kind` is "shock" (arrival) or "ambient". */
    ripple(s, kind) {
      const big = s.q.magnitude;
      const dur = kind === 'shock' ? 3.0 + Math.max(0, big - 4) * 0.35 : 4.2;
      s.ripples.push({ t0: this.time, dur, kind, scale: kind === 'shock' ? 1 : 0.55 });
      if (kind === 'shock') s.ripples.push({ t0: this.time + 0.28, dur: dur * 0.85, kind, scale: 0.6 });
      if (s.ripples.length > 6) s.ripples.splice(0, s.ripples.length - 6);
    }
    visible(s) { return this.clock == null || (s.q.timeMs != null && s.q.timeMs <= this.clock); }

    /* Move the replay clock, raising a shockwave for every event it passes. */
    advanceClock(to) {
      const from = this.clock;
      this.clock = to;
      const passed = [];
      this.sprites.forEach(s => {
        const t = s.q.timeMs;
        if (t != null && (from == null ? false : t > from) && t <= to) { this.ripple(s, 'shock'); s.appear = 0; s.born = this.time; passed.push(s); }
      });
      return passed;
    }

    tick(dt) {
      this.time += dt;
      const t = this.time, reduce = FX.reducedMotion();
      let removed = false;
      this.sprites.forEach((s, id) => {
        if (t >= s.born && s.appear < 1) {
          if (s.shockAt != null && !s.shocked && !reduce) { s.shocked = true; this.ripple(s, 'shock'); }
          s.appear = Math.min(1, s.appear + dt / (reduce ? 0.01 : 0.55));
        }
        if (s.dying) { s.fade -= dt / 0.35; if (s.fade <= 0) { this.sprites.delete(id); removed = true; return; } }
        else if (s.fade < 1) s.fade = Math.min(1, s.fade + dt / 0.2);
        if (s.ripples.length) s.ripples = s.ripples.filter(r => t - r.t0 < r.dur);
        // big recent events keep pinging, so they stay findable
        if (!reduce && s.tier >= 3 && !s.dying && s.appear >= 1 && t >= s.nextAmbient && this.visible(s)) {
          const age = Date.now() - (s.q.timeMs || 0);
          if (this.clock != null || age < 86400000 * 3) this.ripple(s, 'ambient');
          s.nextAmbient = t + 4.2 + FX.hash01(s.id + Math.floor(t)) * 2.4;
        }
      });
      if (this.dirty || removed) {
        this.list = Array.from(this.sprites.values()).sort((a, b) => a.q.magnitude - b.q.magnitude);
        this.dirty = false;
      }
    }
    get(id) { return this.sprites.get(id) || null; }
    /* Nearest visible sprite within `slop` px of (x, y); `place` supplies the
       screen position. Bigger events win ties, since they draw on top. */
    pick(x, y, place, slop) {
      let best = null, bestD = Infinity;
      for (let i = this.list.length - 1; i >= 0; i--) {
        const s = this.list[i];
        if (s.dying || !this.visible(s) || s.appear < 0.4) continue;
        const p = place(s);
        if (!p) continue;
        const reach = Math.max(slop || 12, s.r + 6), d = Math.hypot(p.x - x, p.y - y);
        if (d <= reach && d - s.r * 0.4 < bestD) { best = s; bestD = d - s.r * 0.4; }
      }
      return best;
    }
  }

  /* The subsolar point at a moment: where the sun is directly overhead. */
  function subsolar(ms) {
    const d = new Date(ms), start = Date.UTC(d.getUTCFullYear(), 0, 0);
    const day = (ms - start) / 86400000;
    const dec = 23.44 * Math.sin(TAU * (day - 81) / 365);
    const hours = d.getUTCHours() + d.getUTCMinutes() / 60 + d.getUTCSeconds() / 3600;
    return { lat: dec, lon: wrapLon((12 - hours) * 15) };
  }

  return { D2R, R2D, vec, latLon, tangents, onCircle, Ortho, mercY, mercLat, wrapLon, fitFlat,
           radiusFor, shockDegrees, EventLayer, subsolar, MERC_MAX };
});
