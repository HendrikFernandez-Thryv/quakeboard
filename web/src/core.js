/* quakeboard core - geo maths, region gazetteer, USGS client, search and
   analysis. Nothing in here touches the DOM, so the same file runs in the
   browser and under Node, where the tests exercise it. */
(function (root, factory) {
  var data = root.QB_DATA || (typeof require === 'function' ? require('./gazetteer.js') : null);
  var api = factory(data);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.QB = api;
})(typeof self !== 'undefined' ? self : globalThis, function (DATA) {
  'use strict';

  const FEED_BASE = 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary';
  const QUERY_URL = 'https://earthquake.usgs.gov/fdsnws/event/1/query';
  const COUNT_URL = 'https://earthquake.usgs.gov/fdsnws/event/1/count';
  const EVENT_HOST = 'https://earthquake.usgs.gov/';
  const MAX_EVENTS = 20000;        // the service refuses queries above this
  const BOARD_LIMIT = 2000;        // the live board never asks for more
  const TEXT_SCAN_LIMIT = 5000;    // events we will pull down to match a name

  const FEEDS = {
    hour:  { slug: 'all_hour',  big: '4.5_hour',  label: 'last hour',    short: '1h',  seconds: 3600 },
    day:   { slug: 'all_day',   big: '4.5_day',   label: 'last 24 hours', short: '24h', seconds: 86400 },
    week:  { slug: 'all_week',  big: '4.5_week',  label: 'last 7 days',  short: '7d',  seconds: 604800 },
    month: { slug: 'all_month', big: '4.5_month', label: 'last 30 days', short: '30d', seconds: 2592000 },
  };
  const FEED_ORDER = ['hour', 'day', 'week', 'month'];

  /* ------------------------------------------------------------ formatting */

  const pad2 = n => (n < 10 ? '0' : '') + n;
  const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

  function fmtInt(n) {
    return n == null || !isFinite(n) ? '–' : Math.round(n).toLocaleString('en-US');
  }
  function fmtDateTime(ms) {
    if (ms == null) return 'unknown';
    const d = new Date(ms);
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' +
      pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
  }
  function fmtUTC(ms) {
    if (ms == null) return 'unknown';
    const d = new Date(ms);
    return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate()) + ' ' +
      pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes()) + ':' + pad2(d.getUTCSeconds()) + ' UTC';
  }
  function humanizeAge(seconds) {
    seconds = Math.floor(seconds);
    if (seconds < 60) return seconds + 's ago';
    if (seconds < 3600) return Math.floor(seconds / 60) + 'm ago';
    if (seconds < 172800) return Math.floor(seconds / 3600) + 'h ago';
    return Math.floor(seconds / 86400) + 'd ago';
  }
  function humanizeSpan(seconds) {
    seconds = Math.floor(Math.abs(seconds));
    if (seconds < 60) return seconds + 's';
    if (seconds < 3600) return Math.floor(seconds / 60) + 'm';
    if (seconds < 172800) return Math.floor(seconds / 3600) + 'h';
    return Math.floor(seconds / 86400) + 'd';
  }
  /* "%g"-style: no trailing zeros, no float noise (4.3 + 0.1 -> 4.4). */
  function num(x) { return String(Number(Number(x).toPrecision(6))); }

  /* ------------------------------------------------------------------- geo */

  const EARTH_R = 6371.0088;
  const rad = d => d * Math.PI / 180;
  const deg = r => r * 180 / Math.PI;
  const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
                   'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

  function haversine(lat1, lon1, lat2, lon2) {
    if (lat1 == null || lon1 == null || lat2 == null || lon2 == null) return null;
    const p1 = rad(lat1), p2 = rad(lat2), dp = p2 - p1, dl = rad(lon2 - lon1);
    const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
    return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(a)));
  }
  function bearing(lat1, lon1, lat2, lon2) {
    if (lat1 == null || lon1 == null || lat2 == null || lon2 == null) return null;
    const p1 = rad(lat1), p2 = rad(lat2), dl = rad(lon2 - lon1);
    const y = Math.sin(dl) * Math.cos(p2);
    const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
    return (deg(Math.atan2(y, x)) + 360) % 360;
  }
  function compass(d) {
    if (d == null) return '';
    return COMPASS[Math.floor((((d % 360) + 360) % 360) / 22.5 + 0.5) % 16];
  }
  function directionFrom(lat1, lon1, lat2, lon2) {
    return compass(bearing(lat1, lon1, lat2, lon2));
  }
  function formatKm(km) {
    if (km == null) return '?';
    if (km < 10) return km.toFixed(1) + ' km';
    if (km < 1000) return Math.round(km) + ' km';
    return Math.round(km).toLocaleString('en-US') + ' km';
  }
  /* Point reached from (lat, lon) travelling `km` along `bearingDeg`. */
  function destination(lat, lon, bearingDeg, km) {
    const d = km / EARTH_R, b = rad(bearingDeg), p1 = rad(lat), l1 = rad(lon);
    const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(b));
    const l2 = l1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(p1),
                               Math.cos(d) - Math.sin(p1) * Math.sin(p2));
    return [deg(p2), ((deg(l2) + 540) % 360) - 180];
  }
  function parseLatLon(text) {
    const parts = String(text == null ? '' : text).replace(/;/g, ',').split(',').map(s => s.trim());
    if (parts.length !== 2) throw new Error("expected 'LAT,LON', got '" + text + "'");
    const lat = Number(parts[0]), lon = Number(parts[1]);
    if (parts[0] === '' || parts[1] === '' || !isFinite(lat) || !isFinite(lon)) {
      throw new Error("expected 'LAT,LON' as numbers, got '" + text + "'");
    }
    if (lat < -90 || lat > 90) throw new Error('latitude ' + lat + ' is outside -90..90');
    if (lon < -180 || lon > 180) throw new Error('longitude ' + lon + ' is outside -180..180');
    return [lat, lon];
  }

  /* --------------------------------------------------------------- regions */

  const BOXES = DATA.boxes, ALIASES = DATA.aliases, DISPLAY = DATA.display;
  const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

  function displayName(key) {
    if (has(DISPLAY, key)) return DISPLAY[key];
    return key.split(' ').filter(Boolean)
      .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
  }
  function normalize(text) {
    text = String(text == null ? '' : text).trim().toLowerCase()
      .normalize('NFKD').replace(/[̀-ͯ]/g, '');
    return text.replace(/[^\p{L}\p{N}.]+/gu, ' ').trim().replace(/\s+/g, ' ');
  }
  function boxesFor(key) {
    const v = BOXES[key];
    return Array.isArray(v[0]) ? v : [v];
  }

  /* difflib.SequenceMatcher.ratio(), ported so that fuzzy matches agree with
     the terminal app's. Ties are broken the same way (earliest, then
     longest), which is why the loop order matters. */
  function longestMatch(a, b, alo, ahi, blo, bhi) {
    let besti = alo, bestj = blo, bestsize = 0, j2len = {};
    for (let i = alo; i < ahi; i++) {
      const next = {};
      for (let j = blo; j < bhi; j++) {
        if (a[i] === b[j]) {
          const k = (j2len[j - 1] || 0) + 1;
          next[j] = k;
          if (k > bestsize) { besti = i - k + 1; bestj = j - k + 1; bestsize = k; }
        }
      }
      j2len = next;
    }
    return [besti, bestj, bestsize];
  }
  function matchingChars(a, b) {
    let total = 0;
    const queue = [[0, a.length, 0, b.length]];
    while (queue.length) {
      const [alo, ahi, blo, bhi] = queue.pop();
      const [i, j, k] = longestMatch(a, b, alo, ahi, blo, bhi);
      if (k) {
        total += k;
        if (alo < i && blo < j) queue.push([alo, i, blo, j]);
        if (i + k < ahi && j + k < bhi) queue.push([i + k, ahi, j + k, bhi]);
      }
    }
    return total;
  }
  function ratio(a, b) {
    const t = a.length + b.length;
    return t ? 2 * matchingChars(a, b) / t : 1;
  }
  /* difflib.get_close_matches(word, possibilities, n, cutoff) */
  function closeMatches(word, possibilities, n, cutoff) {
    const scored = [];
    possibilities.forEach(function (x) {
      const r = ratio(x, word);
      if (r >= cutoff) scored.push([r, x]);
    });
    scored.sort((p, q) => (q[0] - p[0]) || (q[1] < p[1] ? -1 : q[1] > p[1] ? 1 : 0));
    return scored.slice(0, n).map(s => s[1]);
  }

  const byLength = (a, b) => a.length - b.length;

  /* Free text -> {key, boxes, how}, or null. `how` says how sure we are:
     "exact", "partial" (we completed or trimmed it) or "guess" (fuzzy).

     Unlike the terminal app, a known name appearing inside the query must be
     a whole word of three or more characters, and the longest one wins.
     Without that, "andrew" matched the alias "dr" and resolved to the
     Dominican Republic, and "all of japan" resolved to worldwide. */
  function resolve(query) {
    let q = normalize(query);
    if (!q) return null;
    if (has(ALIASES, q)) q = ALIASES[q];
    if (has(BOXES, q)) return { key: q, boxes: boxesFor(q), how: 'exact' };

    const names = Object.keys(BOXES).concat(Object.keys(ALIASES));
    const target = n => has(ALIASES, n) ? ALIASES[n] : n;

    const starts = names.filter(n => n.startsWith(q)).sort(byLength);
    if (starts.length) {
      const key = target(starts[0]);
      return { key, boxes: boxesFor(key), how: q.length > 3 ? 'exact' : 'partial' };
    }
    // The query is a fragment of a name ("zealand"): the shortest name wins.
    const within = names.filter(n => n.includes(q)).sort(byLength);
    if (within.length) {
      const key = target(within[0]);
      return { key, boxes: boxesFor(key), how: 'partial' };
    }
    // A name is a whole word inside the query ("all of japan"): the most
    // specific - longest - wins, or "all" would beat "japan".
    const padded = ' ' + q + ' ';
    const inside = names.filter(n => n.length >= 3 && padded.includes(' ' + n + ' '))
      .sort((a, b) => b.length - a.length);
    if (inside.length) {
      const key = target(inside[0]);
      return { key, boxes: boxesFor(key), how: 'partial' };
    }
    const close = closeMatches(q, names, 1, 0.78);
    if (close.length) {
      const key = target(close[0]);
      return { key, boxes: boxesFor(key), how: 'guess' };
    }
    return null;
  }
  /* Names to offer when a query resolves to nothing. */
  function suggest(query, limit) {
    limit = limit || 6;
    const q = normalize(query), names = Object.keys(BOXES).sort();
    if (!q) return names.slice(0, limit);
    const hits = names.filter(n => n.includes(q));
    closeMatches(q, names.concat(Object.keys(ALIASES)), limit, 0.5).forEach(function (n) {
      n = has(ALIASES, n) ? ALIASES[n] : n;
      if (hits.indexOf(n) < 0) hits.push(n);
    });
    return hits.slice(0, limit);
  }
  /* Ranked suggestions as you type: [{key, label, via}] */
  function complete(query, limit) {
    limit = limit || 8;
    const q = normalize(query);
    if (!q) return [];
    const scored = new Map();
    const offer = function (key, score, via) {
      const old = scored.get(key);
      if (!old || score < old.score) scored.set(key, { key, score, via: via || null });
    };
    Object.keys(BOXES).forEach(function (key) {
      if (key === q) offer(key, -1);
      else if (key.startsWith(q)) offer(key, 0);
      else if (key.split(' ').some(w => w.startsWith(q))) offer(key, 1);
      else if (key.includes(q)) offer(key, 2);
    });
    Object.keys(ALIASES).forEach(function (alias) {
      if (alias === q) offer(ALIASES[alias], -1, alias);
      else if (alias.startsWith(q) && q.length >= 2) offer(ALIASES[alias], 0.5, alias);
    });
    if (!scored.size && q.length >= 3) {             // only when nothing else matched: "japan" must not offer Spain
      closeMatches(q, Object.keys(BOXES), 4, 0.66).forEach(function (key) {
        offer(key, 3 + (1 - ratio(key, q)));
      });
    }
    return Array.from(scored.values())
      .sort((a, b) => (a.score - b.score) || (displayName(a.key) < displayName(b.key) ? -1 : 1))
      .slice(0, limit)
      .map(s => ({ key: s.key, label: displayName(s.key), via: s.via }));
  }
  function boxContains(box, lat, lon) {
    if (lat == null || lon == null) return false;
    const minLat = box[0], maxLat = box[1], minLon = box[2], maxLon = box[3];
    if (!(minLat <= lat && lat <= maxLat)) return false;
    if (maxLon > 180 && lon < minLon - 180) lon += 360;      // box crosses +180
    if (minLon < -180 && lon > maxLon + 180) lon -= 360;     // box crosses -180
    return minLon <= lon && lon <= maxLon;
  }
  /* Smallest lon/lat rectangle holding every box, for framing a region. */
  function unionBounds(boxes) {
    if (boxes.length === 1) return boxes[0].slice();
    let a = 90, b = -90, c = 180, d = -180;
    boxes.forEach(function (x) {
      a = Math.min(a, x[0]); b = Math.max(b, x[1]);
      c = Math.min(c, x[2]); d = Math.max(d, x[3]);
    });
    return [a, b, c, d];
  }

  /* ----------------------------------------------------------------- model */

  class Quake {
    constructor(o) {
      this.id = o.id || '';
      this.mag = o.mag == null ? null : Number(o.mag);
      this.magType = o.magType || '';
      this.place = o.place || 'unknown location';
      this.timeMs = o.timeMs == null ? null : Number(o.timeMs);
      this.updatedMs = o.updatedMs == null ? null : Number(o.updatedMs);
      this.lat = o.lat == null ? null : Number(o.lat);
      this.lon = o.lon == null ? null : Number(o.lon);
      this.depthKm = o.depthKm == null ? null : Number(o.depthKm);
      this.tsunami = !!o.tsunami;
      this.alert = o.alert || null;
      this.status = o.status || '';
      this.felt = o.felt == null ? null : Number(o.felt);
      this.cdi = o.cdi == null ? null : Number(o.cdi);
      this.mmi = o.mmi == null ? null : Number(o.mmi);
      this.sig = o.sig == null ? null : Number(o.sig);
      this.net = o.net || '';
      this.url = o.url || '';
      this.etype = o.etype || 'earthquake';
      this.title = o.title || '';
    }
    static fromFeature(feat) {
      const p = feat.properties || {}, g = feat.geometry || {};
      const c = (g.coordinates || []).slice();
      while (c.length < 3) c.push(null);
      return new Quake({
        id: feat.id, mag: p.mag, magType: p.magType, place: p.place,
        timeMs: p.time, updatedMs: p.updated, lon: c[0], lat: c[1], depthKm: c[2],
        tsunami: p.tsunami, alert: p.alert, status: p.status, felt: p.felt,
        cdi: p.cdi, mmi: p.mmi, sig: p.sig, net: p.net, url: p.url,
        etype: p.type, title: p.title,
      });
    }
    /* Magnitude as a number, or -99 for events that have none yet. */
    get magnitude() { return this.mag == null ? -99 : this.mag; }
    get epoch() { return this.timeMs == null ? 0 : this.timeMs / 1000; }
    ageSeconds(nowSec) {
      return Math.max(0, (nowSec == null ? Date.now() / 1000 : nowSec) - this.epoch);
    }
    tier() {
      const m = this.magnitude;
      return m >= 7 ? 4 : m >= 6 ? 3 : m >= 5 ? 2 : m >= 4 ? 1 : 0;
    }
    magText() { return this.mag == null ? '?' : this.mag.toFixed(1); }
    depthText() { return this.depthKm == null ? '?' : this.depthKm.toFixed(1) + ' km'; }
    localTime() { return fmtDateTime(this.timeMs); }
    utcTime() { return fmtUTC(this.timeMs); }
    /* The event page, but only if it really is on the USGS site. */
    safeUrl() { return this.url && this.url.indexOf(EVENT_HOST) === 0 ? this.url : ''; }
    /* Short tags in the terminal app's style: TSU, YEL, felt12, rev. */
    flags() {
      const out = [];
      if (this.tsunami) out.push('TSU');
      if (this.alert) out.push(this.alert.toUpperCase().slice(0, 3));
      if (this.felt) out.push('felt' + this.felt);
      if (this.status === 'reviewed') out.push('rev');
      if (this.etype && this.etype !== 'earthquake') out.push(this.etype.slice(0, 8));
      return out;
    }
  }

  /* ------------------------------------------------------------------- api */

  class ApiError extends Error {
    constructor(message) { super(message); this.name = 'ApiError'; }
  }
  class Fetched {
    constructor(quakes, o) {
      o = o || {};
      this.quakes = quakes;
      this.total = o.total != null ? o.total : quakes.length;
      this.stale = !!o.stale;
      this.cached = !!o.cached;
      this.fetchedAt = o.fetchedAt || Date.now();
      this.generated = o.generated || null;      // when USGS built the response
    }
    get truncated() { return this.total > this.quakes.length; }
  }

  const memo = new Map();          // url -> {t, data}
  const inflight = new Map();      // url -> promise, so identical calls share one
  let store = { get: () => null, set: () => {} };
  function setStore(s) { store = s || store; }
  function remember(url, data) {
    memo.set(url, { t: Date.now(), data });
    if (memo.size > 60) memo.delete(memo.keys().next().value);
  }

  function httpError(status) {
    if (status === 400) return new ApiError('the service rejected that query (HTTP 400)');
    if (status === 404) return new ApiError('not found (HTTP 404)');
    if (status === 429) return new ApiError('rate limited by USGS (HTTP 429) - try again shortly');
    if (status >= 500) return new ApiError('USGS service error (HTTP ' + status + ')');
    return new ApiError('HTTP ' + status + ' from USGS');
  }
  async function request(url, timeout, fresh) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeout);
    try {
      const resp = await fetch(url, { signal: ctl.signal, cache: fresh ? 'no-cache' : 'default' });
      if (resp.status === 204) return { type: 'FeatureCollection', features: [] };
      if (!resp.ok) throw httpError(resp.status);
      return await resp.json();
    } catch (e) {
      if (e instanceof ApiError) throw e;
      if (e && e.name === 'AbortError') throw new ApiError('the request timed out');
      if (e instanceof SyntaxError) throw new ApiError('malformed response from USGS');
      throw new ApiError('network unreachable or blocked');
    } finally {
      clearTimeout(timer);
    }
  }
  /* GET and parse JSON. Serves a recent copy for `minAge` seconds; and if the
     network is down, falls back to the last good copy and says it is stale. */
  async function fetchJSON(url, o) {
    o = o || {};
    const timeout = o.timeout || 20000, attempts = o.attempts || 2;
    const old = memo.get(url);
    if (old && o.minAge > 0 && Date.now() - old.t < o.minAge * 1000) {
      return { data: old.data, stale: false, cached: true, fetchedAt: old.t };
    }
    if (inflight.has(url)) return inflight.get(url);
    const job = (async function () {
      let last = null;
      for (let n = 0; n < attempts; n++) {
        try {
          const data = await request(url, timeout, o.fresh);
          remember(url, data);
          if (o.persistKey) store.set(o.persistKey, { t: Date.now(), data });
          return { data, stale: false, cached: false, fetchedAt: Date.now() };
        } catch (e) {
          last = e;
          if (e.message.indexOf('(HTTP 4') > 0) break;      // retrying a 4xx is pointless
          if (n + 1 < attempts) await new Promise(r => setTimeout(r, o.retryDelay != null ? o.retryDelay : 800));
        }
      }
      if (old) return { data: old.data, stale: true, cached: true, fetchedAt: old.t };
      const kept = o.persistKey ? store.get(o.persistKey) : null;
      if (kept && kept.data) return { data: kept.data, stale: true, cached: true, fetchedAt: kept.t };
      throw last || new ApiError('request failed');
    })();
    inflight.set(url, job);
    try { return await job; } finally { inflight.delete(url); }
  }

  function quakesFrom(payload) {
    const feats = (payload && payload.features) || [];
    return feats.filter(f => f && typeof f === 'object').map(Quake.fromFeature)
      .sort((a, b) => b.epoch - a.epoch);
  }
  const toMs = t => (t instanceof Date ? t.getTime() : Number(t));
  const iso = ms => new Date(ms).toISOString().slice(0, 19);

  /* Build FDSN parameters. A search URL is also a cache key, so "now" is
     never baked in to the second: the start time is rounded down to
     `quantize` seconds and the end time is left for the server to default. */
  function queryParams(o) {
    const p = [['format', 'geojson']];
    let start = o.start != null ? toMs(o.start) : null;
    if (start == null) {
      const q = (o.quantize || 60) * 1000;
      start = Math.floor((Date.now() - Math.max(0.01, Number(o.days) || 30) * 86400000) / q) * q;
    }
    p.push(['starttime', iso(start)]);
    if (o.end != null) p.push(['endtime', iso(toMs(o.end))]);
    if (o.minMag != null) p.push(['minmagnitude', num(o.minMag)]);
    if (o.maxMag != null) p.push(['maxmagnitude', num(o.maxMag)]);
    if (o.minDepth != null) p.push(['mindepth', num(o.minDepth)]);
    if (o.maxDepth != null) p.push(['maxdepth', num(o.maxDepth)]);
    if (o.center && o.radiusKm) {
      p.push(['latitude', num(o.center[0])], ['longitude', num(o.center[1])],
             ['maxradiuskm', num(o.radiusKm)]);
    } else if (o.bbox) {
      p.push(['minlatitude', num(o.bbox[0])], ['maxlatitude', num(o.bbox[1])],
             ['minlongitude', num(o.bbox[2])], ['maxlongitude', num(o.bbox[3])]);
    }
    if (o.limit != null) {
      p.push(['orderby', 'time'], ['limit', String(clamp(Math.floor(o.limit), 1, MAX_EVENTS))]);
    }
    return p.map(kv => kv[0] + '=' + encodeURIComponent(kv[1])).join('&');
  }
  /* How many events match, without downloading them. null on any failure,
     since a count only ever adds context. */
  async function count(o) {
    const url = COUNT_URL + '?' + queryParams(Object.assign({ quantize: 3600 }, o, { limit: null }));
    try {
      const r = await fetchJSON(url, { timeout: 20000, attempts: 1, minAge: 300 });
      const n = r.data && r.data.count;
      return isFinite(n) && n !== null ? Number(n) : null;
    } catch (e) { return null; }
  }
  async function search(o) {
    o = Object.assign({ minMag: 2.5, days: 30, limit: 500 }, o);
    const url = QUERY_URL + '?' + queryParams(o);
    const r = await fetchJSON(url, { timeout: 30000, minAge: o.minAge != null ? o.minAge : 30, persistKey: o.persistKey, fresh: o.fresh, retryDelay: o.retryDelay });
    const quakes = quakesFrom(r.data);
    let total = null;
    if (o.withTotal !== false && quakes.length >= (o.limit || MAX_EVENTS)) total = await count(o);
    return new Fetched(quakes, { total, stale: r.stale, cached: r.cached, fetchedAt: r.fetchedAt });
  }
  /* The live board. 4.5+ uses USGS's pre-built feeds, which sit behind a CDN;
     below that an FDSN query keeps the download to what is actually shown. */
  async function fetchFeed(period, minMag, o) {
    o = o || {};
    if (!FEEDS[period]) period = 'day';
    const feed = FEEDS[period];
    let url, limit = null, start = null;
    if (minMag >= 4.5) {
      url = FEED_BASE + '/' + feed.big + '.geojson';
    } else {
      limit = BOARD_LIMIT;
      start = Math.floor((Date.now() - feed.seconds * 1000) / 60000) * 60000;
      url = QUERY_URL + '?' + queryParams({ minMag, start, limit });
    }
    const r = await fetchJSON(url, { timeout: 25000, fresh: o.fresh, retryDelay: o.retryDelay, persistKey: 'board:' + period + ':' + minMag });
    const quakes = quakesFrom(r.data).filter(q => q.mag == null || q.magnitude >= minMag);
    let total = null;
    if (limit && quakes.length >= limit) total = await count({ minMag, start });
    const meta = r.data && r.data.metadata;
    return new Fetched(quakes, { total, stale: r.stale, cached: r.cached, fetchedAt: r.fetchedAt,
                                 generated: meta && meta.generated });
  }

  /* --------------------------------------------------------------- service */

  class SearchResult {
    constructor(query, quakes, label, note, o) {
      o = o || {};
      this.query = query;
      this.quakes = quakes;
      this.label = label;            // resolved region, or the raw text
      this.note = note;              // how the query was interpreted
      this.total = o.total != null ? o.total : quakes.length;
      this.stale = !!o.stale;
      this.center = o.center || null;       // [lat, lon] for radius searches
      this.radiusKm = o.radiusKm || null;
      this.scanned = o.scanned || null;     // events examined for a text search
      this.bounds = o.bounds || null;       // [minLat, maxLat, minLon, maxLon]
      this.key = o.key || null;             // gazetteer key, when there is one
      this.how = o.how || null;
      this.fetchedAt = o.fetchedAt || Date.now();
    }
    get truncated() { return this.total > this.quakes.length; }
  }
  function dedupe(quakes) {
    const seen = new Set(), out = [];
    quakes.forEach(function (q) {
      if (!seen.has(q.id)) { seen.add(q.id); out.push(q); }
    });
    return out.sort((a, b) => b.epoch - a.epoch);
  }

  /* Search by country or region name; anything the gazetteer does not know
     is matched against the place text instead. */
  async function searchPlace(query, o) {
    o = Object.assign({ minMag: 2.5, days: 30, limit: 500, strict: false }, o);
    query = String(query == null ? '' : query).trim();
    if (!query) throw new Error('empty search');
    const hit = resolve(query);
    return hit ? regionSearch(query, hit, o) : textSearch(query, o);
  }
  async function regionSearch(query, hit, o) {
    const boxes = hit.boxes, label = displayName(hit.key);
    const perBox = Math.max(20, Math.floor(o.limit / Math.max(1, boxes.length)));
    const results = await Promise.all(boxes.map(box =>
      search({ minMag: o.minMag, days: o.days, bbox: box, limit: perBox, fresh: o.fresh })));
    let found = dedupe([].concat(...results.map(r => r.quakes)));
    let total = Math.max(results.reduce((s, r) => s + r.total, 0), found.length);
    const stale = results.some(r => r.stale);
    let note = hit.how === 'exact' ? 'region match'
      : hit.how === 'partial' ? 'closest match to “' + query + '”'
      : 'best guess for “' + query + '”';
    if (o.strict) {
      const needle = normalize(query);
      found = found.filter(q => normalize(q.place).includes(needle));
      note += ', name-filtered';
      total = found.length;
    }
    return new SearchResult(query, found.slice(0, o.limit), label, note,
      { total, stale, bounds: unionBounds(boxes), key: hit.key, how: hit.how });
  }
  /* FDSN cannot match on place names, so this pulls events and filters here.
     The count endpoint says how big that would be first, and the magnitude
     floor is raised rather than quietly downloading everything. */
  async function textSearch(query, o) {
    const needle = normalize(query);
    const available = await count({ minMag: o.minMag, days: o.days });
    let floor = o.minMag, extra = '';
    if (available && available > TEXT_SCAN_LIMIT) {
      floor = null;
      for (const bump of [0.5, 1.0, 1.5, 2.0, 2.5, 3.0]) {
        const probe = await count({ minMag: o.minMag + bump, days: o.days });
        if (probe != null && probe <= TEXT_SCAN_LIMIT) {
          floor = o.minMag + bump;
          extra = ' (scan narrowed to M' + floor.toFixed(1) + '+: ' + fmtInt(available) +
            ' events matched M' + o.minMag.toFixed(1) + '+ over ' + num(o.days) + 'd)';
          break;
        }
      }
      if (floor == null) {
        floor = o.minMag + 3;
        extra = ' (scan narrowed to M' + floor.toFixed(1) + '+)';
      }
    }
    const res = await search({ minMag: floor, days: o.days, limit: TEXT_SCAN_LIMIT, withTotal: false, fresh: o.fresh });
    const matched = dedupe(res.quakes.filter(q => normalize(q.place).includes(needle)));
    return new SearchResult(query, matched.slice(0, o.limit), query,
      'text match on place name' + extra,
      { total: matched.length, stale: res.stale, scanned: res.quakes.length, how: 'text' });
  }
  /* A circle around a point: the right shape for "near me". */
  async function near(lat, lon, o) {
    o = Object.assign({ radiusKm: 300, minMag: 2.5, days: 30, limit: 500 }, o);
    const res = await search({ minMag: o.minMag, days: o.days, center: [lat, lon],
                               radiusKm: o.radiusKm, limit: o.limit, fresh: o.fresh });
    const name = o.label || (lat.toFixed(3) + ', ' + lon.toFixed(3));
    return new SearchResult('near ' + name, res.quakes, name, 'within ' + formatKm(o.radiusKm),
      { total: res.total, stale: res.stale, center: [lat, lon], radiusKm: o.radiusKm, how: 'near' });
  }

  /* ---------------------------------------------------- aftershock analysis */

  /* A plausible aftershock-zone radius: surface rupture length from Wells &
     Coppersmith (1994), log10(L) = 0.59 M - 2.44, widened by half again and
     kept between 25 and 400 km. */
  function aftershockRadiusKm(magnitude) {
    if (magnitude == null || magnitude < 0) return 25;
    const length = Math.pow(10, 0.59 * magnitude - 2.44);
    return Math.max(25, Math.min(400, 1.5 * length));
  }

  class Sequence {
    constructor(main, radiusKm, days, before, after, o) {
      o = o || {};
      this.main = main;
      this.radiusKm = radiusKm;
      this.days = days;
      this.minMag = o.minMag;
      this.foreshocks = before;
      this.aftershocks = after;
      this.stale = !!o.stale;
    }
    get largest() {
      return this.aftershocks.reduce((a, q) => (!a || q.magnitude > a.magnitude ? q : a), null);
    }
    get largestForeshock() {
      return this.foreshocks.reduce((a, q) => (!a || q.magnitude > a.magnitude ? q : a), null);
    }
    /* Aftershocks per 24 h since the mainshock, oldest bucket first. */
    countsByDay(buckets) {
      const out = new Array(buckets || 7).fill(0);
      this.aftershocks.forEach(q => {
        const day = Math.floor((q.epoch - this.main.epoch) / 86400);
        if (day >= 0 && day < out.length) out[day]++;
      });
      return out;
    }
    rateFirstDay() {
      return this.aftershocks.filter(q => q.epoch - this.main.epoch <= 86400).length;
    }
    rateLastDay(nowSec) {
      const now = nowSec == null ? Date.now() / 1000 : nowSec;
      return this.aftershocks.filter(q => now - q.epoch <= 86400).length;
    }
    elapsedDays(nowSec) {
      const now = nowSec == null ? Date.now() / 1000 : nowSec;
      return Math.max(0, (now - this.main.epoch) / 86400);
    }
    /* Mainshock minus largest aftershock. Bath's law puts this near 1.2; a
       much smaller gap hints the event is not the biggest of its sequence. */
    bathGap() {
      const big = this.largest;
      if (!big || this.main.mag == null) return null;
      return this.main.magnitude - big.magnitude;
    }
    /* Every neighbour as a plot point: days since the mainshock (negative
       before it) and distance from the epicentre. */
    points() {
      const m = this.main;
      return this.foreshocks.concat(this.aftershocks).map(q => ({
        quake: q,
        days: (q.epoch - m.epoch) / 86400,
        km: haversine(m.lat, m.lon, q.lat, q.lon),
        bearing: bearing(m.lat, m.lon, q.lat, q.lon),
      })).sort((a, b) => a.days - b.days);
    }
    verdict(nowSec) {
      const main = this.main, fore = this.largestForeshock;
      const foreBigger = fore && main.mag != null && fore.magnitude > main.magnitude;
      if (!this.aftershocks.length) {
        let note = 'No aftershocks recorded above the search magnitude - either it is quiet ' +
          'or smaller events are below the floor.';
        if (foreBigger) {
          note += ' A larger event (M' + fore.magText() + ') came first, so this looks like an ' +
            'aftershock itself.';
        }
        return note;
      }
      const gap = this.bathGap(), parts = [];
      if (foreBigger) {
        parts.push('A larger event (M' + fore.magText() + ') came first, so this is part of ' +
          'that sequence rather than its mainshock.');
      }
      const first = this.rateFirstDay(), last = this.rateLastDay(nowSec);
      if (this.elapsedDays(nowSec) < 1) {
        parts.push('Still in the first 24 hours, when the rate is highest and revisions are common.');
      } else if (last === 0) {
        parts.push('Nothing in the last 24 hours - the sequence looks to have quietened down.');
      } else if (first && last) {
        const r = last / first;
        if (r < 0.34) {
          parts.push('The rate is decaying as you would expect, from ' + first +
            ' on day one to ' + last + ' in the last 24 hours.');
        } else if (r > 1.5) {
          parts.push('The rate is higher now (' + last + ' in 24h) than on day one (' +
            first + ') - worth watching.');
        } else {
          parts.push('The rate is holding roughly steady at ' + last + ' per day.');
        }
      }
      if (gap != null && gap < 0) {
        parts.push('A later event was larger, so this was a foreshock.');
      } else if (gap != null && gap < 0.5) {
        parts.push('The largest aftershock is within ' + gap.toFixed(1) + ' of the mainshock, ' +
          'closer than the usual gap of about 1.2.');
      }
      return parts.join(' ') || 'Sequence in progress.';
    }
  }

  async function sequence(main, o) {
    o = o || {};
    if (main.lat == null || main.lon == null) throw new Error('this event has no coordinates');
    const nowSec = Date.now() / 1000;
    const radiusKm = o.radiusKm || aftershockRadiusKm(main.magnitude);
    const days = o.days != null ? o.days
      : Math.max(7, Math.min(90, (nowSec - main.epoch) / 86400 + 1));
    // About three units below the mainshock keeps the list informative without
    // dragging in every microquake the network recorded.
    const minMag = o.minMag != null ? o.minMag : (main.mag ? Math.max(1, main.mag - 3) : 1);
    const start = main.timeMs - Math.min(30, days) * 86400000;
    const res = await search({ minMag, center: [main.lat, main.lon], radiusKm,
                               limit: o.limit || 2000, start, withTotal: false });
    const before = [], after = [];
    res.quakes.forEach(q => {
      if (q.id === main.id) return;
      (q.epoch > main.epoch ? after : before).push(q);
    });
    return new Sequence(main, radiusKm, days, before, after, { stale: res.stale, minMag });
  }

  /* ------------------------------------------------- is this unusual? */

  class Activity {
    constructor(label, minMag, recentDays, recent, baselineDays, baseline, bands) {
      this.label = label;
      this.minMag = minMag;
      this.recentDays = recentDays;
      this.recent = recent;
      this.baselineDays = baselineDays;
      this.baseline = baseline;
      this.bands = bands || [];      // [{lo, hi, n}] - hi null means open-ended
    }
    /* Events expected in `recentDays`, given the longer-run rate. */
    get expected() {
      if (this.baseline == null || !this.baselineDays) return null;
      return this.baseline * (this.recentDays / this.baselineDays);
    }
    get ratio() {
      const exp = this.expected;
      if (!exp || this.recent == null) return null;
      return this.recent / exp;
    }
    verdict() {
      const ratio = this.ratio;
      if (ratio == null || this.recent == null) return 'Not enough history to judge.';
      const exp = this.expected;
      if (this.recent < 5 && exp < 5) {
        return 'Too few events either way (' + this.recent + ' against about ' +
          exp.toFixed(0) + ' expected) to read much into it.';
      }
      let word;
      if (ratio >= 2.5) word = 'far above';
      else if (ratio >= 1.4) word = 'above';
      else if (ratio <= 0.4) word = 'far below';
      else if (ratio <= 0.7) word = 'below';
      else {
        return 'About normal: ' + this.recent + ' events against roughly ' + exp.toFixed(0) +
          ' expected over ' + num(this.recentDays) + ' days.';
      }
      return this.recent + ' events, ' + word + ' the usual ' + exp.toFixed(0) + ' for ' +
        num(this.recentDays) + ' days (' + ratio.toFixed(1) + 'x the 12-month rate).';
    }
  }

  /* Compare an area's last 30 days with its trailing year. Only the count
     endpoint is used, so this is a handful of tiny requests. */
  async function activity(o) {
    o = Object.assign({ minMag: 2.5, recentDays: 30, baselineDays: 365 }, o);
    let name, shapes;
    if (o.center && o.radiusKm) {
      name = o.label || (o.center[0].toFixed(3) + ', ' + o.center[1].toFixed(3));
      shapes = [{ center: o.center, radiusKm: o.radiusKm }];
    } else if (o.query) {
      const hit = resolve(o.query);
      if (!hit) throw new Error('unknown region: ' + o.query);
      name = o.label || displayName(hit.key);
      shapes = hit.boxes.map(b => ({ bbox: b }));
    } else {
      name = o.label || 'Worldwide';
      shapes = [{}];
    }
    const total = async function (extra) {
      const counts = await Promise.all(shapes.map(s => count(Object.assign({}, s, extra))));
      return counts.some(n => n == null) ? null : counts.reduce((a, b) => a + b, 0);
    };
    const edges = [[o.minMag, 4], [4, 5], [5, 6], [6, null]].filter(b => b[1] == null || b[1] > o.minMag);
    const [recent, baseline, ...bandCounts] = await Promise.all([
      total({ minMag: o.minMag, days: o.recentDays }),
      total({ minMag: o.minMag, days: o.baselineDays }),
      // half-open bands, so an event at exactly 5.0 is counted once
      ...edges.map(b => total({ minMag: Math.max(b[0], o.minMag), maxMag: b[1] == null ? null : b[1] - 0.001, days: o.recentDays })),
    ]);
    const bands = edges.map((b, i) => ({ lo: Math.max(b[0], o.minMag), hi: b[1], n: bandCounts[i] }));
    return new Activity(name, o.minMag, o.recentDays, recent, o.baselineDays, baseline, bands);
  }

  /* ---------------------------------------------------------------- export */

  return {
    FEEDS, FEED_ORDER, BOARD_LIMIT, MAX_EVENTS, TEXT_SCAN_LIMIT,
    Quake, ApiError, Fetched, SearchResult, Sequence, Activity,
    fmt: { int: fmtInt, dateTime: fmtDateTime, utc: fmtUTC, age: humanizeAge, span: humanizeSpan, num, clamp },
    geo: { haversine, bearing, compass, directionFrom, formatKm, destination, parseLatLon, rad, deg, EARTH_R },
    regions: { BOXES, ALIASES, normalize, resolve, suggest, complete, displayName, boxesFor, boxContains, unionBounds, ratio, closeMatches },
    api: { fetchJSON, fetchFeed, search, count, queryParams, setStore, quakesFrom, clearMemo: () => memo.clear() },
    service: { searchPlace, near, sequence, activity, aftershockRadiusKm },
  };
});
