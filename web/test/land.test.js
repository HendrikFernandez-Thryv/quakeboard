'use strict';
const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const QBLand = require('../src/land.js');

let land;
before(async () => { land = await QBLand.load(); });

describe('land mask', () => {
  test('decodes the embedded coastlines', () => {
    assert.ok(land.polys.length > 100, 'polygons: ' + land.polys.length);
    assert.ok(land.runs.length >= land.polys.length);
    for (const poly of land.polys) for (const ring of poly) {
      const a = ring[0], b = ring[ring.length - 1];
      assert.deepEqual(a, b, 'every ring is closed');
    }
  });
  test('knows land from sea', () => {
    const land_ = [['Paris', 48.85, 2.35], ['Tokyo', 35.7, 139.7], ['Amazon', -3, -60], ['Sahara', 25, 10],
      ['Dallas', 32.78, -96.8], ['Sydney', -33.9, 151.2], ['Antarctica', -80, 0], ['Greenland', 72, -40],
      ['Kansas', 38.5, -98], ['Siberia', 62, 100]];
    const sea = [['mid-Atlantic', 30, -40], ['Pacific', 0, -150], ['Arctic Ocean', 85, -120],
      ['Indian Ocean', -20, 80], ['Gulf of Mexico', 25, -90], ['Bay of Bengal', 15, 88], ['Southern Ocean', -55, 100]];
    for (const [n, lat, lon] of land_) assert.equal(land.isLand(lat, lon), true, n);
    for (const [n, lat, lon] of sea) assert.equal(land.isLand(lat, lon), false, n);
  });
  test('holes stay holes (the Caspian Sea is water)', () => {
    assert.equal(land.isLand(42, 50.5), false);
    assert.equal(land.isLand(47, 40), true);                  // the steppe beside it
  });
  test('longitude wraps and bad input is safe', () => {
    assert.equal(land.isLand(48.85, 2.35 + 360), land.isLand(48.85, 2.35));
    assert.equal(land.isLand(null, 0), false);
    assert.equal(land.isLand(90, 0), false);
    assert.equal(land.isLand(-90, 0), true);                  // the pole is ice
  });
  test('the south polar cap is land, although the source data stops at 85.6S', () => {
    for (const lat of [-85.7, -88, -89.9, -90]) for (const lon of [-170, -90, 0, 90, 170]) {
      assert.equal(land.isLand(lat, lon), true, lat + ',' + lon);
    }
    assert.equal(land.isLand(85, 0), false);                  // the Arctic is ocean
  });
  test('no polygon edge jumps across the map (the antimeridian bug)', () => {
    for (const poly of land.polys) for (const ring of poly) for (let i = 1; i < ring.length; i++) {
      if (Math.abs(ring[i][1]) > 89.9 && Math.abs(ring[i - 1][1]) > 89.9) continue;      // Antarctica's closure runs along the pole
      assert.ok(Math.abs(ring[i][0] - ring[i - 1][0]) < 180, 'edge spans ' + Math.abs(ring[i][0] - ring[i - 1][0]).toFixed(1) + ' degrees of longitude at lat ' + ring[i][1].toFixed(2));
    }
  });
  test('open ocean has no stripes of phantom land', () => {
    // these were 1,000+ cells of land in a row: fake land across the Indian and Pacific Oceans
    for (const [lat, lon] of [[-16.375, 78], [-16.375, 100], [-16.375, -120], [65.0, -30], [71.5, -175], [70.5, -178], [71.3, 170]]) {
      assert.equal(land.isLand(lat, lon), false, lat + ',' + lon);
    }
    const W = QBLand.MASK_W, H = QBLand.MASK_H, count = r => { let n = 0; for (let x = 0; x < W; x++) n += land.mask[r * W + x]; return n; };
    for (let r = 2; r < H - 2; r++) {
      const lat = 90 - (r + 0.5) * 0.25;
      if (lat < -60 || lat > 83) continue;                                  // Antarctica and the Arctic rim legitimately fill rows
      const c = count(r), around = Math.max(count(r - 2), count(r + 2));
      assert.ok(c - around < 450, 'row at ' + lat.toFixed(2) + ' has ' + c + ' land cells against ' + around + ' two rows away');
    }
  });
  test('land that straddles the antimeridian is still land on both sides', () => {
    assert.equal(land.isLand(-17.8, 178.0), true, 'Viti Levu, Fiji');
    assert.equal(land.isLand(-16.6, 179.3), true, 'Vanua Levu, Fiji');
    assert.equal(land.isLand(67.0, 175.0), true, 'Chukotka, west of the seam');
    assert.equal(land.isLand(66.0, -175.0), true, 'Chukotka, east of the seam');
    assert.equal(land.isLand(71.0, 179.5), true, 'Wrangel Island');
    assert.equal(land.isLand(68.0, -175.0), false, 'the sea north of Chukotka');
  });
  test('about 30% of the planet by area is land', () => {
    // sample by area (cos latitude) rather than by cell
    let land_ = 0, total = 0;
    for (let lat = -89.5; lat < 90; lat += 1) for (let lon = -179.5; lon < 180; lon += 1) {
      const w = Math.cos(lat * Math.PI / 180); total += w; if (land.isLand(lat, lon)) land_ += w;
    }
    const share = land_ / total;
    assert.ok(share > 0.27 && share < 0.33, 'land share ' + share.toFixed(3));
  });
  test('land points are unit vectors, on land, and plentiful', () => {
    const pts = land.points(20000);
    assert.equal(pts.length % 3, 0);
    assert.ok(pts.length / 3 > 4500 && pts.length / 3 < 7500, 'count ' + pts.length / 3);
    for (let i = 0; i < pts.length; i += 3) {
      const len = Math.hypot(pts[i], pts[i + 1], pts[i + 2]);
      assert.ok(Math.abs(len - 1) < 1e-5);
    }
    let onLand = 0;
    for (let i = 0; i < pts.length; i += 3) {
      const lat = Math.asin(pts[i + 2]) * 180 / Math.PI, lon = Math.atan2(pts[i + 1], pts[i]) * 180 / Math.PI;
      if (land.isLand(lat, lon)) onLand++;
    }
    assert.equal(onLand, pts.length / 3);
  });
  test('the seam and the pole are never stroked as coastline', () => {
    const onSeam = p => Math.abs(Math.abs(p[0]) - 180) < 0.02;
    for (const run of land.runs) for (let i = 1; i < run.length; i++) {
      const a = run[i - 1], b = run[i];
      assert.ok(!(onSeam(a) && onSeam(b)), 'seam edge ' + JSON.stringify([a, b]));
      assert.ok(!(Math.abs(a[1]) > 89.9 && Math.abs(b[1]) > 89.9), 'pole edge');
    }
  });
  test('coast runs stay continuous across the antimeridian rather than hopping over it', () => {
    for (const run of land.runs) for (let i = 1; i < run.length; i++) assert.ok(Math.abs(run[i][0] - run[i - 1][0]) < 180);
  });
  test('coast runs convert to unit vectors', () => {
    const xyz = land.runsXYZ();
    assert.equal(xyz.length, land.runs.length);
    const a = xyz[0];
    assert.ok(Math.abs(Math.hypot(a[0], a[1], a[2]) - 1) < 1e-5);
  });
});
