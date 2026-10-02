/* World geometry for the maps. Decodes the embedded TopoJSON coastlines,
   rasterises them to a land/sea mask, and derives what the renderers need:
   coastline runs, land-dot points for the globe, and an isLand() lookup. */
(function (root, factory) {
  var blob = root.QB_LAND || (typeof require === 'function' ? require('./landdata.js') : null);
  var api = factory(blob);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.QBLand = api;
})(typeof self !== 'undefined' ? self : globalThis, function (BLOB) {
  'use strict';

  const MASK_W = 1440, MASK_H = 720;           // 0.25 degree cells

  function b64ToBytes(b64) {
    const bin = atob(b64), out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  /* zlib-wrapped deflate, which is what DecompressionStream calls "deflate". */
  async function inflate(bytes) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  /* A ring that straddles the antimeridian hops from +180 to -180 in the source
     data. Drawn or filled in a flat lon/lat plane, that hop is a 360-degree
     wide edge: a stripe of phantom land across an ocean. Unwrap the ring so
     its longitudes are continuous (they may then run past +-180). A ring that
     winds once round a pole, like Antarctica, ends up 360 degrees from where
     it began; close that one through the pole so it encloses the ice. */
  function unwrapRing(ring) {
    const out = [[ring[0][0], ring[0][1]]];
    let shift = 0;
    for (let i = 1; i < ring.length; i++) {
      const d = ring[i][0] - ring[i - 1][0];
      if (d > 180) shift -= 360; else if (d < -180) shift += 360;
      out.push([ring[i][0] + shift, ring[i][1]]);
    }
    // Unwrapping shifts everything after a seam hop by a whole turn, which can
    // carry an outline a full 360 degrees from the holes inside it. Re-centre
    // the ring so its average longitude sits within half a turn of zero.
    const mean = out.reduce((t, p) => t + p[0], 0) / out.length, turn = -360 * Math.round(mean / 360);
    if (turn) out.forEach(p => { p[0] += turn; });
    const first = out[0], last = out[out.length - 1];
    if (Math.abs(last[0] - first[0]) > 180) {
      const pole = out.reduce((s, p) => s + p[1], 0) < 0 ? -90 : 90;
      out.push([last[0], pole], [first[0], pole], [first[0], first[1]]);
    } else if (last[0] !== first[0] || last[1] !== first[1]) out.push([first[0], first[1]]);
    return out;
  }

  /* TopoJSON -> polygons. A polygon is a list of rings (outline, then holes);
     a ring is a list of [lon, lat]. */
  function decode(topo) {
    const sx = topo.transform.scale[0], sy = topo.transform.scale[1];
    const tx = topo.transform.translate[0], ty = topo.transform.translate[1];
    const arcs = topo.arcs.map(function (arc) {
      let x = 0, y = 0;
      return arc.map(function (p) { x += p[0]; y += p[1]; return [x * sx + tx, y * sy + ty]; });
    });
    function ring(indices) {
      const pts = [];
      indices.forEach(function (i) {
        const arc = i < 0 ? arcs[~i].slice().reverse() : arcs[i];
        arc.forEach(function (p, k) { if (!(pts.length && k === 0)) pts.push(p); });
      });
      return unwrapRing(pts);
    }
    const polys = [];
    topo.objects.land.geometries.forEach(function (g) {
      if (g.type === 'Polygon') polys.push(g.arcs.map(ring));
      else if (g.type === 'MultiPolygon') g.arcs.forEach(poly => polys.push(poly.map(ring)));
    });
    return polys;
  }

  /* Scanline even-odd fill, one polygon at a time (so its holes are paired
     with its own outline and never with a neighbour's), OR-ed into the mask.
     A span that runs past +-180 wraps round to the other side. */
  function rasterize(polys, w, h) {
    const data = new Uint8Array(w * h);
    polys.forEach(function (poly) {
      const rows = new Map();
      poly.forEach(function (ring) {
        for (let i = 0; i < ring.length - 1; i++) {
          let lon1 = ring[i][0], lat1 = ring[i][1], lon2 = ring[i + 1][0], lat2 = ring[i + 1][1];
          if (lat1 === lat2) continue;
          if (lat1 > lat2) { let t = lon1; lon1 = lon2; lon2 = t; t = lat1; lat1 = lat2; lat2 = t; }
          // rows whose centre latitude falls in [lat1, lat2)
          const r0 = Math.max(0, Math.ceil((90 - lat2) * h / 180 - 0.5));
          const r1 = Math.min(h - 1, Math.ceil((90 - lat1) * h / 180 - 0.5) - 1);
          for (let r = r0; r <= r1; r++) {
            const lat = 90 - (r + 0.5) * 180 / h;
            let xs = rows.get(r); if (!xs) rows.set(r, xs = []);
            xs.push(lon1 + (lat - lat1) * (lon2 - lon1) / (lat2 - lat1));
          }
        }
      });
      rows.forEach(function (xs, r) {
        xs.sort((a, b) => a - b);
        for (let i = 0; i + 1 < xs.length; i += 2) {
          let a = Math.floor((xs[i] + 180) * w / 360), b = Math.floor((xs[i + 1] + 180) * w / 360);
          if (b - a >= w) { a = 0; b = w - 1; }
          for (let x = a; x <= b; x++) data[r * w + (((x % w) + w) % w)] = 1;
        }
      });
    });
    return data;
  }

  /* Coastline runs: each ring, split wherever an edge merely follows the map
     seam (+-180 degrees) or the pole, so those never get stroked. */
  function coastRuns(polys) {
    const runs = [];
    const onSeam = p => Math.abs(Math.abs(p[0]) - 180) < 0.02;
    const seam = (a, b) => (onSeam(a) && onSeam(b)) || (Math.abs(a[1]) > 89.9 && Math.abs(b[1]) > 89.9);
    polys.forEach(function (poly) {
      poly.forEach(function (ring) {
        let run = [ring[0]];
        for (let i = 1; i < ring.length; i++) {
          if (seam(ring[i - 1], ring[i])) {
            if (run.length > 1) runs.push(run);
            run = [ring[i]];
          } else run.push(ring[i]);
        }
        if (run.length > 1) runs.push(run);
      });
    });
    return runs;
  }

  class Land {
    constructor(polys) {
      this.polys = polys;
      this.mask = rasterize(polys, MASK_W, MASK_H);
      this.runs = coastRuns(polys);
    }
    isLand(lat, lon) {
      if (lat == null || lon == null) return false;
      const x = Math.floor((((lon + 180) % 360) + 360) % 360 * MASK_W / 360);
      const y = Math.max(0, Math.min(MASK_H - 1, Math.floor((90 - lat) * MASK_H / 180)));
      return this.mask[y * MASK_W + x] === 1;
    }
    /* Roughly evenly spread land samples on the sphere (a Fibonacci lattice
       filtered through the mask), as interleaved unit vectors x,y,z. */
    points(n) {
      const golden = Math.PI * (3 - Math.sqrt(5)), out = [];
      for (let i = 0; i < n; i++) {
        const y = 1 - 2 * (i + 0.5) / n, r = Math.sqrt(1 - y * y);
        const theta = i * golden;
        const lat = Math.asin(y) * 180 / Math.PI;
        let lon = (theta * 180 / Math.PI) % 360;
        if (lon > 180) lon -= 360;
        if (this.isLand(lat, lon)) out.push(r * Math.cos(theta), r * Math.sin(theta), y);
      }
      return new Float32Array(out);
    }
    /* Coastline runs as flat unit-vector arrays, ready for the globe. */
    runsXYZ() {
      return this.runs.map(function (run) {
        const a = new Float32Array(run.length * 3);
        run.forEach(function (p, i) {
          const lat = p[1] * Math.PI / 180, lon = p[0] * Math.PI / 180, c = Math.cos(lat);
          a[i * 3] = c * Math.cos(lon); a[i * 3 + 1] = c * Math.sin(lon); a[i * 3 + 2] = Math.sin(lat);
        });
        return a;
      });
    }
  }

  async function load() {
    const json = new TextDecoder().decode(await inflate(b64ToBytes(BLOB)));
    return new Land(decode(JSON.parse(json)));
  }

  return { load, decode, unwrapRing, rasterize, coastRuns, Land, inflate, b64ToBytes, MASK_W, MASK_H };
});
