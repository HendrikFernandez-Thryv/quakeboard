'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const M = require('../src/fx-map-core.js');
const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) < (eps || 1e-9), (msg || '') + ` ${a} vs ${b}`);

describe('sphere geometry', () => {
  test('vec and latLon are inverses', () => {
    for (const [lat, lon] of [[0, 0], [35.7, 139.7], [-33.9, 151.2], [89, 10], [-45, -170], [10, 179.9]]) {
      const [a, b] = M.latLon(M.vec(lat, lon));
      near(a, lat, 1e-9); near(b, lon, 1e-9);
    }
  });
  test('the centre of the view projects to the middle and faces the viewer', () => {
    const o = new M.Ortho(), out = [0, 0, 0];
    for (const [lat, lon] of [[0, 0], [35, 139], [-60, -45], [80, 170]]) {
      o.set(lat, lon); const v = M.vec(lat, lon);
      o.rot(v[0], v[1], v[2], out);
      near(out[0], 0, 1e-12); near(out[1], 0, 1e-12); near(out[2], 1, 1e-12);
    }
  });
  test('east is to the right, north is up', () => {
    const o = new M.Ortho(), out = [0, 0, 0];
    o.set(0, 0);
    let v = M.vec(0, 20); o.rot(v[0], v[1], v[2], out); assert.ok(out[0] > 0.3 && Math.abs(out[1]) < 1e-9, 'east of centre should be right');
    v = M.vec(20, 0); o.rot(v[0], v[1], v[2], out); assert.ok(out[1] > 0.3 && Math.abs(out[0]) < 1e-9, 'north of centre should be up');
  });
  test('the far side is hidden', () => {
    const o = new M.Ortho(), out = [0, 0, 0];
    o.set(0, 0); const v = M.vec(0, 180); o.rot(v[0], v[1], v[2], out);
    assert.ok(out[2] < -0.99);
  });
  test('rot and unrot are inverses', () => {
    const o = new M.Ortho(), out = [0, 0, 0];
    o.set(23, -77);
    for (const [lat, lon] of [[20, -70], [40, -100], [5, -60], [60, -40]]) {
      const v = M.vec(lat, lon); o.rot(v[0], v[1], v[2], out);
      assert.ok(out[2] > 0);
      const [a, b] = o.unrot(out[0], out[1], out[2]);
      near(a, lat, 1e-7); near(b, lon, 1e-7);
    }
  });
  test('tangent vectors are orthonormal and point east and north', () => {
    for (const [lat, lon] of [[0, 0], [45, 100], [-70, -30], [89.9999, 0], [-90, 0]]) {
      const v = M.vec(lat, lon), t = M.tangents(v);
      const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
      near(Math.hypot(...t.east), 1, 1e-9); near(Math.hypot(...t.north), 1, 1e-9);
      near(dot(t.east, t.north), 0, 1e-9); near(dot(t.east, v), 0, 1e-9); near(dot(t.north, v), 0, 1e-9);
    }
    const t = M.tangents(M.vec(0, 0));
    near(t.east[1], 1); near(t.north[2], 1);
  });
  test('a circle on the sphere stays at a constant angular distance', () => {
    const v = M.vec(35, 139), t = M.tangents(v), p = [0, 0, 0];
    for (let b = 0; b < 360; b += 15) {
      M.onCircle(v, t, 0.2, b * M.D2R, p);
      near(Math.hypot(...p), 1, 1e-9);
      near(Math.acos(v[0] * p[0] + v[1] * p[1] + v[2] * p[2]), 0.2, 1e-9);
    }
  });
});

describe('mercator', () => {
  test('latitude round-trips and is clamped', () => {
    for (const lat of [-80, -45, 0, 12.3, 60, 84]) near(M.mercLat(M.mercY(lat)), lat, 1e-9);
    near(M.mercY(90), M.mercY(M.MERC_MAX));
  });
  test('wrapLon stays in range', () => {
    assert.equal(M.wrapLon(190), -170); assert.equal(M.wrapLon(-190), 170); assert.equal(M.wrapLon(0), 0); assert.equal(M.wrapLon(540), -180);
  });
  test('fitFlat centres the box and is tighter for a smaller region', () => {
    const japan = M.fitFlat([24, 46, 122, 146.5], 800, 500, 30);
    near(japan.lon, 134.25, 1e-9);
    assert.ok(japan.lat > 30 && japan.lat < 40);
    const tokyo = M.fitFlat([34.9, 36.3, 138.6, 140.6], 800, 500, 30);
    assert.ok(tokyo.scale > japan.scale * 5);
  });
  test('a box crossing the antimeridian centres on the far side', () => {
    const fiji = M.fitFlat([-25, -8, 160, 200], 800, 500, 30);
    near(M.wrapLon(fiji.lon - 180), M.wrapLon(0), 1e-9, 'centre is 180');
  });
  test('limits clamp the scale', () => {
    const f = M.fitFlat([0, 0.1, 0, 0.1], 800, 500, 30, { min: 100, max: 5000 });
    assert.equal(f.scale, 5000);
  });
});

describe('subsolar point', () => {
  test('at noon UTC on an equinox the sun is over the Gulf of Guinea', () => {
    const p = M.subsolar(Date.UTC(2026, 2, 20, 12, 0, 0));
    assert.ok(Math.abs(p.lat) < 2, 'declination ' + p.lat);
    assert.ok(Math.abs(p.lon) < 1e-9);
  });
  test('the sun is overhead in the northern tropics at the June solstice, and moves west with time', () => {
    const a = M.subsolar(Date.UTC(2026, 5, 21, 0, 0, 0)), b = M.subsolar(Date.UTC(2026, 5, 21, 6, 0, 0));
    assert.ok(a.lat > 22 && a.lat < 24);
    near(M.wrapLon(a.lon - b.lon), 90, 1e-9, 'six hours is 90 degrees');
  });
});

describe('EventLayer', () => {
  const quake = (id, mag, lat, lon, ms) => ({ id, mag, magnitude: mag == null ? -99 : mag, lat, lon, timeMs: ms == null ? Date.now() : ms,
    epoch: (ms == null ? Date.now() : ms) / 1000, tier: () => (mag >= 7 ? 4 : mag >= 6 ? 3 : mag >= 5 ? 2 : mag >= 4 ? 1 : 0) });
  test('radius grows with magnitude and never vanishes', () => {
    assert.equal(M.radiusFor(4), 4);
    assert.ok(M.radiusFor(7) > M.radiusFor(5) && M.radiusFor(5) > M.radiusFor(4));
    assert.ok(M.radiusFor(1) >= 2.6 && M.radiusFor(null) >= 2.6);
  });
  test('adds, keeps and fades out events', () => {
    const L = new M.EventLayer();
    L.setQuakes([quake('a', 5, 10, 20), quake('b', 6, 11, 21)]);
    L.tick(1);
    assert.equal(L.list.length, 2);
    assert.deepEqual(L.list.map(s => s.id), ['a', 'b'], 'ascending magnitude');
    assert.equal(L.get('a').appear, 1);
    L.setQuakes([quake('b', 6, 11, 21)]);
    L.tick(0.1);
    assert.equal(L.get('a').dying, true);
    L.tick(1);
    assert.equal(L.get('a'), null, 'gone after the fade');
    assert.equal(L.list.length, 1);
  });
  test('events without coordinates are skipped', () => {
    const L = new M.EventLayer();
    L.setQuakes([quake('a', 5, null, null), quake('b', 5, 1, 2)]);
    L.tick(1);
    assert.equal(L.list.length, 1);
  });
  test('fresh events get a shockwave, old ones do not', () => {
    const L = new M.EventLayer();
    L.setQuakes([quake('old', 5, 0, 0)]); L.tick(1);
    assert.equal(L.get('old').ripples.length, 0);
    L.setQuakes([quake('old', 5, 0, 0), quake('new', 5, 1, 1)], { fresh: new Set(['new']) });
    L.tick(0.1);
    assert.ok(L.get('new').ripples.length >= 1);
    assert.equal(L.get('old').ripples.length, 0);
    for (let i = 0; i < 400; i++) L.tick(0.05);
    assert.equal(L.get('new').ripples.filter(r => r.kind === 'shock').length, 0, 'shockwaves end');
  });
  test('the replay clock hides later events and pings the ones it passes', () => {
    const L = new M.EventLayer();
    L.setQuakes([quake('early', 5, 0, 0, 1000), quake('late', 5, 1, 1, 5000)]); L.tick(1);
    L.clock = 2000;
    assert.equal(L.visible(L.get('early')), true);
    assert.equal(L.visible(L.get('late')), false);
    const passed = L.advanceClock(6000);
    assert.deepEqual(passed.map(s => s.id), ['late']);
    assert.equal(L.visible(L.get('late')), true);
  });
  test('picking prefers the nearest event and ignores hidden ones', () => {
    const L = new M.EventLayer();
    L.setQuakes([quake('a', 5, 0, 0), quake('b', 5, 0, 1)]); L.tick(1);
    const place = s => ({ x: s.id === 'a' ? 100 : 130, y: 50 });
    assert.equal(L.pick(102, 50, place).id, 'a');
    assert.equal(L.pick(128, 52, place).id, 'b');
    assert.equal(L.pick(300, 300, place), null);
    L.clock = 0;
    assert.equal(L.pick(102, 50, place), null, 'not yet happened');
  });
  test('the cascade staggers arrivals', () => {
    const L = new M.EventLayer();
    const qs = Array.from({ length: 30 }, (_, i) => quake('e' + i, 4 + (i % 3), i, i, 1000 + i));
    L.setQuakes(qs, { cascade: true });
    const borns = Array.from(L.sprites.values()).map(s => s.born);
    assert.ok(Math.max(...borns) > Math.min(...borns));
    assert.ok(Math.max(...borns) <= 1.5 + 1e-9);
  });
});
