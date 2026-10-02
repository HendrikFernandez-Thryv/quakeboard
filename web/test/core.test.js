'use strict';
/* Run with:  node --test web/test
   Offline. Fixtures come from the terminal app (tools/gen_web_fixtures.py), so
   these tests also check that the JavaScript port agrees with the Python. */
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const QB = require('../src/core.js');
const FX = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures.json'), 'utf8'));
const { regions, geo, fmt, api, service, Quake } = QB;

/* ---------------------------------------------------------------- helpers */

function feature(id, mag, timeMs, lat, lon, extra) {
  return { type: 'Feature', id,
    properties: Object.assign({ mag, place: 'place of ' + id, time: timeMs, magType: 'mb', status: 'reviewed' }, extra),
    geometry: { type: 'Point', coordinates: [lon, lat, 10] } };
}
/* Replace fetch with a handler; returns the list of URLs requested. */
function mockFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push(String(url));
    const r = await handler(String(url), opts, calls.length);
    if (r instanceof Error) throw r;
    const status = r.status || 200;
    return { ok: status >= 200 && status < 300, status,
      json: async () => { if (r.badJson) throw new SyntaxError('bad json'); return r.body; } };
  };
  return calls;
}
const collection = feats => ({ type: 'FeatureCollection', metadata: { generated: 1 }, features: feats });
const isCount = url => url.includes('/count?');
const param = (url, name) => new URL(url).searchParams.get(name);

beforeEach(() => { api.clearMemo(); api.setStore({ get: () => null, set: () => {} }); });

/* ------------------------------------------------- parity with the Python */

describe('parity with the terminal app', () => {
  test('region resolution agrees', () => {
    const bad = [];
    for (const [q, key, how] of FX.resolve) {
      const r = regions.resolve(q);
      const got = r ? [r.key, r.how] : [null, null];
      if (got[0] !== key || got[1] !== how) bad.push(`${JSON.stringify(q)}: python ${key}/${how}, js ${got[0]}/${got[1]}`);
    }
    assert.deepEqual(bad, []);
  });
  test('normalize agrees', () => {
    for (const [input, want] of FX.normalize) assert.equal(regions.normalize(input), want, JSON.stringify(input));
  });
  test('difflib ratio agrees', () => {
    for (const [a, b, want] of FX.ratio) assert.ok(Math.abs(regions.ratio(a, b) - want) < 1e-12, `${a}/${b}`);
  });
  test('get_close_matches agrees', () => {
    const pool = Object.keys(regions.BOXES).concat(Object.keys(regions.ALIASES));
    for (const [word, want] of FX.closeMatches) assert.deepEqual(regions.closeMatches(word, pool, 3, 0.6), want, word);
  });
  test('display names agree', () => {
    for (const [key, want] of FX.display) assert.equal(regions.displayName(key), want);
  });
  test('distance, bearing and compass agree', () => {
    for (const [a, b, c, d, want] of FX.haversine) assert.ok(Math.abs(geo.haversine(a, b, c, d) - want) < 1e-6);
    for (const [a, b, c, d, want] of FX.bearing) assert.ok(Math.abs(geo.bearing(a, b, c, d) - want) < 1e-9);
    for (const [deg, want] of FX.compass) assert.equal(geo.compass(deg), want, String(deg));
    for (const [km, want] of FX.formatKm) assert.equal(geo.formatKm(km), want, String(km));
  });
  test('aftershock radius agrees', () => {
    for (const [m, want] of FX.radius) assert.ok(Math.abs(service.aftershockRadiusKm(m) - want) < 1e-9, String(m));
  });
  test('box containment agrees, including across the antimeridian', () => {
    for (const [box, lat, lon, want] of FX.boxContains) assert.equal(regions.boxContains(box, lat, lon), want, JSON.stringify([box, lat, lon]));
  });
  test('sequence verdicts and statistics agree', () => {
    const mk = e => Quake.fromFeature(feature(e.id, e.mag, (FX.now + e.t) * 1000, e.lat, e.lon));
    for (const s of FX.sequences) {
      const seq = new QB.Sequence(mk(s.main), 50, 30, s.before.map(mk), s.after.map(mk), { minMag: 3 });
      assert.equal(seq.verdict(FX.now), s.verdict, s.name);
      assert.deepEqual(seq.countsByDay(5), s.counts, s.name);
      assert.equal(seq.rateFirstDay(), s.first, s.name);
      assert.equal(seq.rateLastDay(FX.now), s.last, s.name);
      assert.ok(Math.abs(seq.elapsedDays(FX.now) - s.elapsed) < 1e-9, s.name);
      const gap = seq.bathGap();
      assert.ok(s.bath === null ? gap === null : Math.abs(gap - s.bath) < 1e-9, s.name);
    }
  });
  test('activity verdicts agree', () => {
    for (const a of FX.activities) {
      const act = new QB.Activity(a.label, 2.5, 30, a.recent, 365, a.baseline);
      assert.equal(act.verdict(), a.verdict, a.label);
      if (a.expected === null) assert.equal(act.expected, null);
      else assert.ok(Math.abs(act.expected - a.expected) < 1e-9);
    }
  });
});

/* ------------------------------------------------------ region matching */

describe('regions', () => {
  test('a known name inside a longer query must be a whole word of 3+ letters', () => {
    assert.equal(regions.resolve('andrew'), null);             // was: Dominican Republic, via "dr"
    assert.equal(regions.resolve('dr who'), null);             // two letters are too ambiguous
    assert.equal(regions.resolve('mexico city').key, 'mexico');
    assert.equal(regions.resolve('japan earthquake').key, 'japan');
    assert.equal(regions.resolve('tsunami in usa').key, 'united states');
  });
  test('when several names appear in a query the most specific one wins', () => {
    assert.equal(regions.resolve('all of japan').key, 'japan'); // not the alias "all" = worldwide
  });
  test('a fragment of a name completes to the shortest name containing it', () => {
    assert.equal(regions.resolve('zealand').key, 'new zealand');
    assert.equal(regions.resolve('zealand').how, 'partial');
  });
  test('misspellings are flagged as guesses', () => {
    assert.equal(regions.resolve('chili').how, 'guess');
    assert.equal(regions.resolve('japan').how, 'exact');
  });
  test('completion ranks prefixes first and never offers nothing for a real prefix', () => {
    assert.equal(regions.complete('jap')[0].key, 'japan');
    assert.deepEqual(regions.complete(''), []);
    assert.equal(regions.complete('ca', 10)[0].key, 'california');           // via the "ca" alias
    assert.ok(regions.complete('zealand').some(c => c.key === 'new zealand'));
    assert.ok(regions.complete('grece').some(c => c.key === 'greece'));      // fuzzy, because nothing else matched
    assert.deepEqual(regions.complete('japan').map(c => c.key), ['japan'], 'a real match is not padded with look-alikes (Spain, Java)');
    assert.ok(!regions.complete('jap').some(c => c.key === 'spain'));
  });
  test('every box is sane and every alias points at a real entry', () => {
    for (const key of Object.keys(regions.BOXES)) {
      for (const [a, b, c, d] of regions.boxesFor(key)) {
        assert.ok(a < b && c < d && a >= -90 && b <= 90, key);
      }
    }
    for (const [alias, target] of Object.entries(regions.ALIASES)) assert.ok(regions.BOXES[target], alias);
  });
  test('union of boxes frames the whole region', () => {
    const us = regions.resolve('usa');
    const [a, b, c, d] = regions.unionBounds(us.boxes);
    assert.ok(a <= 18.5 && b >= 72 && c <= -170 && d >= -66);
  });
  test('suggestions for nonsense still return something to try', () => {
    assert.ok(regions.suggest('jap').includes('japan'));
    assert.equal(regions.suggest('').length, 6);
  });
});

/* --------------------------------------------------------- geo and model */

describe('geo', () => {
  test('destination and haversine are inverses', () => {
    const [lat, lon] = geo.destination(35, 139, 60, 500);
    assert.ok(Math.abs(geo.haversine(35, 139, lat, lon) - 500) < 0.01);
    assert.ok(Math.abs(geo.bearing(35, 139, lat, lon) - 60) < 0.5);
  });
  test('destination wraps across the antimeridian', () => {
    const [, lon] = geo.destination(0, 179, 90, 500);
    assert.ok(lon < -170 && lon > -180);
  });
  test('parseLatLon accepts good input and rejects bad', () => {
    assert.deepEqual(geo.parseLatLon(' 35.68 , 139.77 '), [35.68, 139.77]);
    assert.deepEqual(geo.parseLatLon('-1;-2'), [-1, -2]);
    for (const bad of ['', '1', 'a,b', '91,0', '0,181', '1,2,3', ',5']) assert.throws(() => geo.parseLatLon(bad), bad);
  });
});

describe('Quake', () => {
  const q = Quake.fromFeature(feature('us1', 6.4, Date.UTC(2026, 8, 1, 12), 28.9, 128.5,
    { tsunami: 1, alert: 'yellow', felt: 12, url: 'https://earthquake.usgs.gov/earthquakes/eventpage/us1', type: 'earthquake' }));
  test('fields and text', () => {
    assert.equal(q.magText(), '6.4');
    assert.equal(q.depthText(), '10.0 km');
    assert.equal(q.tier(), 3);
    assert.deepEqual(q.flags(), ['TSU', 'YEL', 'felt12', 'rev']);
    assert.match(q.utcTime(), /^2026-09-01 12:00:00 UTC$/);
  });
  test('tier boundaries', () => {
    const tier = m => Quake.fromFeature(feature('x', m, 0, 0, 0)).tier();
    assert.deepEqual([3.9, 4, 5, 6, 7, 9.1].map(tier), [0, 1, 2, 3, 4, 4]);
  });
  test('missing magnitude and coordinates do not break formatting', () => {
    const n = Quake.fromFeature({ id: 'n', properties: { place: 'nowhere' }, geometry: {} });
    assert.equal(n.magText(), '?');
    assert.equal(n.depthText(), '?');
    assert.equal(n.tier(), 0);
    assert.equal(n.localTime(), 'unknown');
    assert.equal(n.lat, null);
  });
  test('only USGS links are trusted', () => {
    assert.equal(q.safeUrl(), 'https://earthquake.usgs.gov/earthquakes/eventpage/us1');
    const evil = Quake.fromFeature(feature('e', 5, 0, 0, 0, { url: 'javascript:alert(1)' }));
    assert.equal(evil.safeUrl(), '');
    const phish = Quake.fromFeature(feature('p', 5, 0, 0, 0, { url: 'https://earthquake.usgs.gov.evil.example/x' }));
    assert.equal(phish.safeUrl(), '');
  });
  test('age never goes negative on clock skew', () => {
    assert.equal(q.ageSeconds(0), 0);
  });
  test('humanised ages', () => {
    assert.deepEqual([5, 125, 7200, 400000].map(fmt.age), ['5s ago', '2m ago', '2h ago', '4d ago']);
    assert.equal(fmt.span(-7200), '2h');
  });
});

/* ------------------------------------------------------------------- api */

describe('query parameters', () => {
  test('no endtime unless asked, and the start is rounded down', () => {
    const real = Date.now;
    Date.now = () => Date.UTC(2026, 8, 30, 12, 34, 56, 789);
    try {
      const url = api.queryParams({ minMag: 4, days: 1 });
      assert.equal(param('http://x/?' + url, 'endtime'), null);
      assert.equal(param('http://x/?' + url, 'starttime'), '2026-09-29T12:34:00');
      Date.now = () => Date.UTC(2026, 8, 30, 12, 34, 59, 999);
      assert.equal(api.queryParams({ minMag: 4, days: 1 }), url, 'same minute, same URL');
      Date.now = () => Date.UTC(2026, 8, 30, 12, 35, 0, 0);
      assert.notEqual(api.queryParams({ minMag: 4, days: 1 }), url, 'next minute, new URL');
    } finally { Date.now = real; }
  });
  test('quantize widens the window for counts', () => {
    const real = Date.now; Date.now = () => Date.UTC(2026, 8, 30, 12, 34, 56);
    try { assert.equal(param('http://x/?' + api.queryParams({ days: 1, quantize: 3600 }), 'starttime'), '2026-09-29T12:00:00'); }
    finally { Date.now = real; }
  });
  test('numbers are printed without float noise; shapes are exclusive', () => {
    const p = new URL('http://x/?' + api.queryParams({ minMag: 4.3 + 0.1, bbox: [1, 2, 3, 4], center: [5, 6], radiusKm: 7, limit: 99999999 }));
    assert.equal(p.searchParams.get('minmagnitude'), '4.4');
    assert.equal(p.searchParams.get('maxradiuskm'), '7');
    assert.equal(p.searchParams.get('minlatitude'), null);          // a circle wins over a box
    assert.equal(p.searchParams.get('limit'), String(QB.MAX_EVENTS)); // clamped
  });
  test('an explicit window is preserved', () => {
    const p = new URL('http://x/?' + api.queryParams({ start: Date.UTC(2026, 0, 1), end: new Date(Date.UTC(2026, 0, 2)) }));
    assert.equal(p.searchParams.get('starttime'), '2026-01-01T00:00:00');
    assert.equal(p.searchParams.get('endtime'), '2026-01-02T00:00:00');
  });
});

describe('fetchJSON', () => {
  const opts = { retryDelay: 0 };
  test('maps HTTP errors and does not retry a 4xx', async () => {
    const calls = mockFetch(() => ({ status: 400 }));
    await assert.rejects(api.fetchJSON('http://x/a', opts), /rejected that query \(HTTP 400\)/);
    assert.equal(calls.length, 1);
  });
  test('retries a 5xx once, then reports it', async () => {
    const calls = mockFetch(() => ({ status: 503 }));
    await assert.rejects(api.fetchJSON('http://x/b', opts), /service error \(HTTP 503\)/);
    assert.equal(calls.length, 2);
  });
  test('rate limiting is reported plainly', async () => {
    mockFetch(() => ({ status: 429 }));
    await assert.rejects(api.fetchJSON('http://x/c', opts), /rate limited/);
  });
  test('a network failure is an ApiError', async () => {
    mockFetch(() => new TypeError('Failed to fetch'));
    await assert.rejects(api.fetchJSON('http://x/d', opts), e => e instanceof QB.ApiError && /network/.test(e.message));
  });
  test('garbage bodies are reported as malformed', async () => {
    mockFetch(() => ({ badJson: true }));
    await assert.rejects(api.fetchJSON('http://x/e', opts), /malformed/);
  });
  test('204 means no events, not an error', async () => {
    mockFetch(() => ({ status: 204 }));
    const r = await api.fetchJSON('http://x/f', opts);
    assert.deepEqual(r.data.features, []);
  });
  test('a recent copy is served without touching the network', async () => {
    const calls = mockFetch(() => ({ body: { n: 1 } }));
    await api.fetchJSON('http://x/g', { minAge: 30 });
    const again = await api.fetchJSON('http://x/g', { minAge: 30 });
    assert.equal(calls.length, 1);
    assert.equal(again.cached, true);
    assert.equal(again.stale, false);
  });
  test('identical concurrent requests share one fetch', async () => {
    const calls = mockFetch(async () => { await new Promise(r => setTimeout(r, 10)); return { body: {} }; });
    await Promise.all([api.fetchJSON('http://x/h'), api.fetchJSON('http://x/h'), api.fetchJSON('http://x/h')]);
    assert.equal(calls.length, 1);
  });
  test('falls back to the last good copy when the network dies, and says so', async () => {
    mockFetch(() => ({ body: { v: 1 } }));
    await api.fetchJSON('http://x/i', opts);
    mockFetch(() => new TypeError('offline'));
    const r = await api.fetchJSON('http://x/i', opts);
    assert.equal(r.stale, true);
    assert.deepEqual(r.data, { v: 1 });
  });
  test('falls back to the persistent store across a reload', async () => {
    const kept = {};
    api.setStore({ get: k => kept[k] || null, set: (k, v) => { kept[k] = v; } });
    mockFetch(() => ({ body: { v: 2 } }));
    await api.fetchJSON('http://x/j', { persistKey: 'k', retryDelay: 0 });
    api.clearMemo();                                   // a fresh page load
    mockFetch(() => new TypeError('offline'));
    const r = await api.fetchJSON('http://x/j', { persistKey: 'k', retryDelay: 0 });
    assert.equal(r.stale, true);
    assert.deepEqual(r.data, { v: 2 });
  });
  test('with nothing to fall back on the error surfaces', async () => {
    mockFetch(() => new TypeError('offline'));
    await assert.rejects(api.fetchJSON('http://x/k', opts), QB.ApiError);
  });
});

describe('fetchFeed', () => {
  const now = Date.now();
  test('M4.5+ uses the CDN-backed summary feed', async () => {
    const calls = mockFetch(() => ({ body: collection([feature('a', 5, now, 0, 0)]) }));
    const f = await api.fetchFeed('day', 4.5, { retryDelay: 0 });
    assert.match(calls[0], /summary\/4\.5_day\.geojson$/);
    assert.equal(f.quakes.length, 1);
  });
  test('below 4.5 an FDSN query keeps the download small', async () => {
    const calls = mockFetch(() => ({ body: collection([feature('a', 4.2, now, 0, 0), feature('b', 3.9, now, 0, 0)]) }));
    const f = await api.fetchFeed('week', 4.0, { retryDelay: 0 });
    assert.equal(param(calls[0], 'minmagnitude'), '4');
    assert.equal(param(calls[0], 'limit'), String(QB.BOARD_LIMIT));
    assert.deepEqual(f.quakes.map(q => q.id), ['a']);              // 3.9 filtered out
  });
  test('reports the true total when the board is capped', async () => {
    const big = Array.from({ length: QB.BOARD_LIMIT }, (_, i) => feature('e' + i, 4, now - i, 0, 0));
    const calls = mockFetch(url => isCount(url) ? { body: { count: 7300 } } : { body: collection(big) });
    const f = await api.fetchFeed('month', 3.0, { retryDelay: 0 });
    assert.equal(f.total, 7300);
    assert.equal(f.truncated, true);
    assert.ok(calls.some(isCount));
  });
  test('results are newest first', async () => {
    mockFetch(() => ({ body: collection([feature('old', 5, 1000, 0, 0), feature('new', 5, 9000, 0, 0)]) }));
    assert.deepEqual((await api.fetchFeed('day', 4.5, { retryDelay: 0 })).quakes.map(q => q.id), ['new', 'old']);
  });
});

/* --------------------------------------------------------------- service */

describe('search', () => {
  test('a region with several boxes queries each and de-duplicates', async () => {
    const calls = mockFetch(() => ({ body: collection([feature('same', 5, 5000, 40, -100), feature('x', 4, 4000, 40, -100)]) }));
    const r = await service.searchPlace('usa', { minMag: 4, days: 30, limit: 500 });
    assert.equal(calls.filter(u => !isCount(u)).length, 3);       // mainland, Alaska, Hawaii
    assert.equal(r.label, 'United States');
    assert.equal(r.quakes.length, 2);                              // duplicates collapsed
    assert.equal(r.note, 'region match');
  });
  test('says when it is showing a fraction of what exists', async () => {
    const page = Array.from({ length: 50 }, (_, i) => feature('e' + i, 4, 1000 + i, 35, 139));
    mockFetch(url => isCount(url) ? { body: { count: 1240 } } : { body: collection(page) });
    const r = await service.searchPlace('japan', { minMag: 4, days: 30, limit: 50 });
    assert.equal(r.total, 1240);
    assert.equal(r.truncated, true);
  });
  test('a loose match is described as such', async () => {
    mockFetch(() => ({ body: collection([]) }));
    assert.match((await service.searchPlace('chili', {})).note, /best guess for/);
    assert.match((await service.searchPlace('jap', {})).note, /closest match/);
  });
  test('strict mode keeps only events whose place names the query', async () => {
    mockFetch(() => ({ body: collection([
      Object.assign(feature('in', 5, 2000, 35, 139), { properties: { mag: 5, place: '10 km N of Tokyo, Japan', time: 2000 } }),
      Object.assign(feature('out', 5, 1000, 35, 139), { properties: { mag: 5, place: 'Izu Islands region', time: 1000 } })]) }));
    const r = await service.searchPlace('japan', { strict: true });
    assert.deepEqual(r.quakes.map(q => q.id), ['in']);
    assert.match(r.note, /name-filtered/);
  });
  test('an unknown name falls back to matching place text, and narrows the scan when huge', async () => {
    const calls = mockFetch(url => {
      if (isCount(url)) {
        const min = Number(param(url, 'minmagnitude'));
        return { body: { count: min >= 3.5 ? 4000 : min >= 3 ? 7000 : 9000 } };
      }
      return { body: collection([
        Object.assign(feature('hit', 4, 2000, 35, -117), { properties: { mag: 4, place: '5 km of Ridgecrest, CA', time: 2000 } }),
        Object.assign(feature('miss', 4, 1000, 0, 0), { properties: { mag: 4, place: 'somewhere else', time: 1000 } })]) };
    });
    const r = await service.searchPlace('ridgecrest', { minMag: 2.5, days: 30 });
    assert.deepEqual(r.quakes.map(q => q.id), ['hit']);
    assert.match(r.note, /text match/);
    assert.match(r.note, /scan narrowed to M3\.5\+/);
    const scan = calls.find(u => !isCount(u));
    assert.equal(param(scan, 'minmagnitude'), '3.5');
    assert.equal(r.scanned, 2);
  });
  test('an empty query is an error, not a worldwide search', async () => {
    await assert.rejects(service.searchPlace('   '), /empty search/);
  });
  test('near searches a circle and labels it', async () => {
    const calls = mockFetch(() => ({ body: collection([]) }));
    const r = await service.near(32.78, -96.8, { radiusKm: 250, label: 'Dallas' });
    assert.equal(param(calls[0], 'maxradiuskm'), '250');
    assert.equal(param(calls[0], 'latitude'), '32.78');
    assert.equal(r.label, 'Dallas');
    assert.deepEqual(r.center, [32.78, -96.8]);
    assert.equal(r.note, 'within 250 km');
  });
});

describe('sequence and activity', () => {
  test('splits neighbours into before and after and drops the mainshock itself', async () => {
    const t0 = Date.UTC(2026, 8, 20);
    const main = Quake.fromFeature(feature('main', 6.5, t0, 10, 20));
    const calls = mockFetch(() => ({ body: collection([
      feature('main', 6.5, t0, 10, 20), feature('fore', 4.1, t0 - 3600e3, 10, 20),
      feature('a1', 5.0, t0 + 3600e3, 10, 20), feature('a2', 4.0, t0 + 7200e3, 10, 20)]) }));
    const seq = await service.sequence(main);
    assert.deepEqual(seq.foreshocks.map(q => q.id), ['fore']);
    assert.deepEqual(seq.aftershocks.map(q => q.id).sort(), ['a1', 'a2']);
    assert.equal(param(calls[0], 'latitude'), '10');
    assert.equal(param(calls[0], 'minmagnitude'), '3.5');          // main - 3
    assert.ok(Math.abs(seq.radiusKm - service.aftershockRadiusKm(6.5)) < 1e-9);
    assert.equal(seq.largest.id, 'a1');
    assert.equal(seq.points().length, 3);
    assert.ok(seq.points()[0].days < 0);                           // foreshock sorts first
  });
  test('an event without coordinates cannot be analysed', async () => {
    await assert.rejects(service.sequence(new Quake({ id: 'n', mag: 5 })), /no coordinates/);
  });
  test('activity totals multi-box regions and splits magnitude bands without overlap', async () => {
    mockFetch(url => {
      const min = Number(param(url, 'minmagnitude')), max = param(url, 'maxmagnitude');
      const days = (Date.now() - Date.parse(param(url, 'starttime') + 'Z')) / 86400000;
      const year = days > 100;
      if (max === null) return { body: { count: year ? 365 : 30 } };
      return { body: { count: min >= 6 ? 1 : min >= 5 ? 4 : 25 } };
    });
    const a = await service.activity({ query: 'usa', minMag: 4 });
    assert.equal(a.label, 'United States');
    assert.equal(a.recent, 90);                                    // three boxes x 30
    assert.equal(a.baseline, 1095);
    assert.deepEqual(a.bands.map(b => b.lo), [4, 5, 6]);           // the [<4) band is dropped at a 4.0 floor
    assert.equal(a.bands[1].hi, 6);
    assert.ok(a.ratio > 0);
  });
  test('activity fails softly when a count is unavailable', async () => {
    mockFetch(() => ({ status: 500 }));
    const a = await service.activity({ query: 'japan' });
    assert.equal(a.recent, null);
    assert.match(a.verdict(), /Not enough history/);
  });
  test('activity rejects an unknown region rather than going worldwide', async () => {
    await assert.rejects(service.activity({ query: 'qwertyuiop' }), /unknown region/);
  });
});
