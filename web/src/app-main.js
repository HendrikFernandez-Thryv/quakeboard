/* Quakeboard - the orchestrator. Owns the state, the refresh loop, search,
   and wires the map, lists, panels and keyboard together. */
(function (global) {
  'use strict';
  const QB = global.QB, FX = global.QBFX, Land = global.QBLand, Seis = global.QBSeismo, MapKit = global.QBMap, C = global.QBCharts, App = global.App;
  const { $, $$, h, icon, clear } = App;
  const now = () => Date.now();
  const clamp = FX.clamp;

  const S = App.state = {
    tab: 'board',
    board: { quakes: [], total: 0, fetchedAt: 0, generated: 0, stale: false, error: '', fetching: false, loaded: false, first: true, failures: 0 },
    search: { res: null, loading: false, error: '', query: '', near: false, params: null, token: 0 },
    known: new Set(), fresh: new Map(), selected: null,
    nextRefresh: 0, lastStart: now(), alertBoxes: [],
  };

  /* ------------------------------------------------------------------ setup */

  const stage = new MapKit.Stage({
    el: $('#stage'), pointerEl: $('#stage-canvases'), globeCanvas: $('#cv-globe'), flatCanvas: $('#cv-flat'),
    onHover: (s, pt) => showTip(s, pt), onSelect: s => { if (s) select(s.q, { from: 'map' }); }, onTick: dt => onStageTick(dt),
  });
  const seis = new Seis.Seismograph($('#cv-seismo'));
  const boardList = new App.List($('#list-board'), { kind: 'board', onOpen: (q, li) => select(q, { opener: li }) });
  const searchList = new App.List($('#list-search'), { kind: 'search', onOpen: (q, li) => select(q, { opener: li }) });
  const activeList = () => (S.tab === 'board' ? boardList : searchList);
  App.stage = stage; App.seis = seis;          // exposed so tests can step the animation by hand

  const segMode = App.seg($('#seg-mode'), v => App.set({ view: v }));
  const segPeriod = App.seg($('#seg-period'), v => App.set({ period: v }));
  const segDays = App.seg($('#seg-days'), v => { App.set({ days: Number(v) }); rerunSearch(); });
  const boardMag = App.range($('#f-board-mag'), $('#f-board-mag-v'), v => v.toFixed(1), null, v => App.set({ minMag: v }));
  const searchMag = App.range($('#f-search-mag'), $('#f-search-mag-v'), v => v.toFixed(1), null, v => { App.set({ searchMinMag: v }); rerunSearch(); });
  const radiusRange = App.range($('#f-radius'), $('#f-radius-v'), v => v + ' km', null, v => { App.set({ homeRadiusKm: v }); rerunSearch(); });
  $('#f-strict').addEventListener('change', e => { App.set({ strict: e.target.checked }); rerunSearch(); });

  /* --------------------------------------------------------- theme and motion */

  const mqLight = matchMedia('(prefers-color-scheme: light)'), mqReduce = matchMedia('(prefers-reduced-motion: reduce)');
  const resolvedTheme = () => { const t = App.settings.theme; return t === 'system' ? (mqLight.matches ? 'light' : 'dark') : t; };
  function applyTheme() {
    const theme = resolvedTheme(), root = document.documentElement;
    root.dataset.theme = theme;
    const meta = document.querySelector('meta[name="theme-color"]'); if (meta) meta.content = theme === 'dark' ? '#060a14' : '#edf0f7';
    const b = $('#btn-theme'); clear(b).append(icon(theme === 'dark' ? 'sun' : 'moon'));
    b.setAttribute('aria-label', 'Switch to ' + (theme === 'dark' ? 'light' : 'dark') + ' theme'); b.title = b.getAttribute('aria-label');
    requestAnimationFrame(() => { const t = FX.readTheme(); stage.setTheme(t); seis.setTheme(t); App.emit('theme'); });
  }
  function applyMotion() {
    const m = App.settings.motion, reduce = m === 'reduced' || (m === 'system' && mqReduce.matches);
    FX.setReducedMotion(reduce);
    document.documentElement.dataset.motion = m;
    $('#seismo').hidden = reduce;
    stage.setSpin(App.settings.spin && !reduce);
    $('#btn-spin').disabled = reduce;
  }
  mqLight.addEventListener && mqLight.addEventListener('change', applyTheme);
  mqReduce.addEventListener && mqReduce.addEventListener('change', applyMotion);

  /* ------------------------------------------------------------- live status */

  const agoText = ms => QB.fmt.age(Math.max(0, (now() - ms) / 1000)).replace(' ago', '');
  function paintLive() {
    const b = S.board, s = App.settings, pill = $('#live'), t = now();
    const offline = navigator.onLine === false;
    let state = 'ok', label = 'LIVE', meta;
    if (offline) { state = 'offline'; label = 'OFFLINE'; meta = b.loaded ? 'showing data from ' + agoText(b.fetchedAt) + ' ago' : 'waiting for a connection'; }
    else if (!b.loaded) { label = b.error ? 'OFFLINE' : 'CONNECTING'; state = b.error ? 'offline' : 'ok'; meta = b.error ? 'retrying in ' + Math.max(0, Math.round((S.nextRefresh - t) / 1000)) + 's' : 'fetching the feed…'; }
    else if (b.stale || b.error) { state = 'stale'; label = 'CACHED'; meta = 'saved copy from ' + agoText(b.fetchedAt) + ' ago'; }
    else if (b.fetching) { label = 'UPDATING'; meta = 'fetching…'; }
    else meta = 'updated ' + agoText(b.fetchedAt) + ' ago · next in ' + Math.max(0, Math.round((S.nextRefresh - t) / 1000)) + 's';
    if (pill.dataset.state !== state) pill.dataset.state = state;
    pill.classList.toggle('busy', b.fetching);
    const ls = $('#live-state'), lm = $('#live-meta');
    if (ls.textContent !== label) ls.textContent = label;
    if (lm.textContent !== meta) lm.textContent = meta;
    const p = b.fetching ? 0 : clamp((t - S.lastStart) / (Math.max(1000, S.nextRefresh - S.lastStart)), 0, 1);
    pill.style.setProperty('--p', p.toFixed(3));
    const gen = b.generated ? 'USGS built this feed ' + agoText(b.generated) + ' ago. ' : '';
    pill.title = gen + 'Click to refresh now (R)';
  }

  /* --------------------------------------------------------------- the board */

  async function refreshBoard(manual) {
    const b = S.board;
    if (b.fetching) return;
    b.fetching = true; S.lastStart = now(); paintLive();
    const cfg = { period: App.settings.period, minMag: App.settings.minMag };
    let ok = false;
    try {
      const f = await QB.api.fetchFeed(cfg.period, cfg.minMag, { fresh: !!manual });
      if (cfg.period !== App.settings.period || cfg.minMag !== App.settings.minMag) { b.fetching = false; return refreshBoard(false); }
      applyBoard(f); ok = true;
      b.failures = 0; b.error = '';
      if (manual) App.toast({ title: 'Board is up to date', body: plural(f.quakes.length, 'event') + ' in view', icon: 'check', life: 2200 });
    } catch (e) {
      b.failures++; b.error = e.message;
      if (!b.loaded) { boardList.error(e.message, () => refreshBoard(true)); $('#count-board').textContent = '–'; }
      else if (b.failures === 1) App.toast({ title: 'Couldn’t refresh the board', body: e.message + ' — will keep trying.', icon: 'offline', life: 5000 });
    } finally {
      b.fetching = false;
      const wait = b.failures ? Math.min(300, App.settings.interval * Math.pow(2, Math.min(b.failures, 4))) : App.settings.interval;
      S.nextRefresh = now() + wait * 1000; S.lastStart = now();
      paintLive();
    }
    return ok;
  }
  const plural = App.plural;

  function applyBoard(f) {
    const b = S.board, first = !b.loaded || b.first;
    const fresh = new Set();
    if (!first) f.quakes.forEach(q => { if (!S.known.has(q.id)) fresh.add(q.id); });
    S.known = new Set(f.quakes.map(q => q.id));
    fresh.forEach(id => S.fresh.set(id, now() + 90e3));
    Object.assign(b, { quakes: f.quakes, total: f.total, stale: f.stale, fetchedAt: f.fetchedAt, generated: f.generated, loaded: true, first: false });
    boardList.flash(false);
    renderBoard();
    if (S.tab === 'board') renderDataset({ cascade: first, fresh });
    if (first) introSeismo(f.quakes); else if (fresh.size) onFresh(f.quakes.filter(q => fresh.has(q.id)));
  }
  const isFresh = q => { const t = S.fresh.get(q.id); if (!t) return false; if (t < now()) { S.fresh.delete(q.id); return false; } return true; };
  const listCtx = showDate => ({ fresh: isFresh, home: App.settings.home, showDate });

  function renderBoard() {
    const b = S.board; if (!b.loaded) return;
    const s = App.settings, label = QB.FEEDS[s.period].label;
    $('#count-board').textContent = b.total > b.quakes.length ? '2k+' : String(b.quakes.length);
    if (!b.quakes.length) {
      boardList.empty({ title: 'Quiet out there', text: 'No events at M' + s.minMag.toFixed(1) + '+ in the ' + label + '. Try a lower magnitude or a longer window.' });
    } else boardList.render(b.quakes, listCtx(s.period === 'week' || s.period === 'month'));
    const st = clear($('#board-status'));
    const bits = [h('b', { text: b.total > b.quakes.length ? 'Showing ' + QB.fmt.int(b.quakes.length) + ' of ' + QB.fmt.int(b.total) : plural(b.quakes.length, 'event') }), ' in the ' + label];
    if (b.stale) bits.push(h('span', { class: 'chip', 'data-c': 'warn' }, icon('offline'), 'cached copy'));
    st.append(h('span', { class: 'grow' }, bits));
    layoutInk();
    if (S.selected) boardList.setSelected(S.selected.id);
  }

  function introSeismo(quakes) {
    quakes.slice(0, 8).reverse().forEach((q, i) => seis.addBurst({ mag: q.magnitude, tier: q.tier(), label: burstLabel(q), delay: 0.7 + i * 1.15 }));
  }
  const shortPlace = p => p.replace(/^\d+\s*km\s+[NSEW]{1,3}\s+of\s+/i, '');
  const burstLabel = q => 'M' + q.magText() + ' · ' + (shortPlace(q.place).length > 30 ? shortPlace(q.place).slice(0, 29) + '…' : shortPlace(q.place));

  function regionOk(q) {
    const boxes = S.alertBoxes; if (!boxes.length) return true;
    return boxes.some(b => QB.regions.boxContains(b, q.lat, q.lon));
  }
  /* New events: burst them across the seismograph, and alert for the big ones. */
  function onFresh(list) {
    const s = App.settings;
    list.slice().sort((a, b) => a.epoch - b.epoch).forEach((q, i) => seis.addBurst({ mag: q.magnitude, tier: q.tier(), label: burstLabel(q), delay: 0.5 + i * 1.0 }));
    const alertable = list.filter(q => q.mag != null && q.magnitude >= s.alertMag && q.ageSeconds() < 6 * 3600 && regionOk(q)).sort((a, b) => b.magnitude - a.magnitude);
    if (!alertable.length) return;
    alertable.slice(0, 3).forEach(q => App.toast({ mag: q.magText(), tier: q.tier(), title: q.place, body: [App.depthLabel(q), QB.fmt.age(q.ageSeconds())].filter(Boolean).join(' · '), onClick: () => select(q, { from: 'toast' }) }));
    if (alertable.length > 3) App.toast({ icon: 'activity', title: '+' + (alertable.length - 3) + ' more new events', body: 'See the live board.', life: 4000 });
    if (s.sound) App.rumble(alertable[0].magnitude);
    if (s.notify) alertable.slice(0, 3).forEach(q => App.osNotify('M' + q.magText() + ' earthquake', q.place + (App.depthLabel(q) ? ' · ' + App.depthLabel(q) : ''), q.id));
    App.say('New earthquake: magnitude ' + alertable[0].magText() + ', ' + alertable[0].place);
  }

  /* --------------------------------------------------------- the active data */

  function dataset() {
    const s = App.settings;
    if (S.tab === 'search' && S.search.res) {
      const r = S.search.res, p = S.search.params;
      return { kind: 'search', quakes: r.quakes, total: r.total, label: r.label, minMag: p.minMag, days: p.days, res: r };
    }
    return { kind: 'board', quakes: S.board.quakes, total: S.board.total || S.board.quakes.length, label: 'Worldwide', minMag: s.minMag,
             days: QB.FEEDS[s.period].seconds / 86400, res: null };
  }
  /* Everything that depends on which dataset is showing. */
  function renderDataset(o) {
    o = o || {};
    const ds = dataset();
    const fresh = new Set(); S.fresh.forEach((t, id) => { if (t > now()) fresh.add(id); });
    stage.setQuakes(ds.quakes, { cascade: !!o.cascade, fresh: o.fresh || fresh });
    if (S.selected) { const sp = stage.layer.get(S.selected.id); if (sp) stage.select(sp); }
    renderKpis(ds); renderLegend(ds); renderHud(ds);
    stopReplayIfDataChanged();
    const note = $('#stage-note');
    note.hidden = !(S.board.loaded && !ds.quakes.length);
    if (!note.hidden) note.textContent = ds.kind === 'board' ? 'No events match the current filters.' : 'No events to plot.';
  }

  function renderHud(ds) {
    const k = $('#hud-kicker'), s = App.settings;
    k.classList.toggle('is-search', ds.kind === 'search');
    k.lastChild.textContent = ds.kind === 'search' ? 'Search' : 'Live';
    if (ds.kind === 'board') {
      $('#hud-title').textContent = 'M' + s.minMag.toFixed(1) + '+ · ' + QB.FEEDS[s.period].label;
      $('#hud-sub').textContent = 'Worldwide';
    } else {
      $('#hud-title').textContent = ds.label;
      $('#hud-sub').textContent = 'M' + ds.minMag.toFixed(1) + '+ · ' + QB.fmt.num(ds.days) + (ds.days === 1 ? ' day' : ' days') + ' · ' + ds.res.note;
    }
  }

  const TIERS = [{ t: 4, label: 'M7+', mag: 7 }, { t: 3, label: 'M6–6.9', mag: 6 }, { t: 2, label: 'M5–5.9', mag: 5 }, { t: 1, label: 'M4–4.9', mag: 4 }, { t: 0, label: '<M4', mag: 3 }];
  function renderLegend(ds) {
    const counts = [0, 0, 0, 0, 0]; ds.quakes.forEach(q => { counts[q.tier()]++; });
    const box = clear($('#legend'));
    box.append(h('span', { class: 'lg-title', text: 'Magnitude' }));
    TIERS.slice().reverse().forEach(x => {
      if (x.t === 0 && !counts[0]) return;
      box.append(h('span', { class: 'item', 'data-tier': x.t, title: counts[x.t] + ' event' + (counts[x.t] === 1 ? '' : 's') },
        h('i', { class: 'dot', style: { '--d': String(2 * global.QBMapCore.radiusFor(x.mag)), '--c': 'var(--m' + x.t + ')', '--c-rgb': 'var(--m' + x.t + '-rgb)' } }),
        x.label, h('span', { class: 'n', text: String(counts[x.t]) })));
    });
  }

  function buckets(quakes, t0, t1, n) {
    const out = new Array(n).fill(0), w = (t1 - t0) / n;
    quakes.forEach(q => { if (q.timeMs == null) return; let i = Math.floor((q.timeMs - t0) / w); if (i === n) i = n - 1; if (i >= 0 && i < n) out[i]++; });
    return out;
  }
  function renderKpis(ds) {
    const qs = ds.quakes, t = now();
    const count = ds.total || qs.length;
    FX.countUp($('#k-events'), count);
    $('#k-events-label').textContent = ds.kind === 'board' ? 'Events' : 'Events in ' + ds.label;
    $('#k-events-sub').textContent = 'M' + ds.minMag.toFixed(1) + '+ · ' + (ds.kind === 'board' ? QB.FEEDS[App.settings.period].label : 'last ' + QB.fmt.num(ds.days) + (ds.days === 1 ? ' day' : ' days'));
    const sp = clear($('#k-events-spark')); sp.append(C.sparkline(buckets(qs, t - ds.days * 86400e3, t, 12), { label: 'Events over the window, 12 equal periods' }));

    const strongest = qs.reduce((a, q) => (!a || q.magnitude > a.magnitude ? q : a), null);
    const tile = $('#tile-max'); tile.className = 'tile card rise' + (strongest ? ' t' + strongest.tier() : '');
    $('#k-max-mark').hidden = !strongest;
    if (strongest && strongest.mag != null) FX.countUp($('#k-max'), strongest.mag, { duration: 800, format: v => 'M' + v.toFixed(1) }); else $('#k-max').textContent = '–';
    $('#k-max-sub').textContent = strongest ? shortPlace(strongest.place) + ' · ' + QB.fmt.age(strongest.ageSeconds()) : ' ';

    const hour = qs.filter(q => q.timeMs != null && t - q.timeMs < 3600e3);
    FX.countUp($('#k-hour'), hour.length, { duration: 700 });
    $('#k-hour-sub').textContent = hour.length === 1 ? 'event' : 'events';
    clear($('#k-hour-spark')).append(C.sparkline(buckets(qs, t - 3600e3, t, 12), { label: 'Events in the past hour, in 5-minute periods' }));

    const deep = qs.reduce((a, q) => (q.depthKm != null && (!a || q.depthKm > a.depthKm) ? q : a), null);
    if (deep) FX.countUp($('#k-deep'), Math.max(0, deep.depthKm), { duration: 800, format: v => Math.round(v) + ' km' }); else $('#k-deep').textContent = '–';
    $('#k-deep-sub').textContent = deep ? shortPlace(deep.place) : ' ';
  }

  /* --------------------------------------------------------------- map tooltip */

  function showTip(s, pt) {
    const tip = $('#map-tip');
    if (!s || !pt) { tip.classList.remove('show'); return; }
    const q = s.q;
    clear(tip).append(h('div', { class: 'tip-row t' + q.tier() }, h('div', { class: 'tip-mag', text: q.magText() }),
      h('div', null, h('div', { class: 'tip-place', text: q.place }), h('div', { class: 'tip-meta', text: [App.depthLabel(q), QB.fmt.age(q.ageSeconds())].filter(Boolean).join(' · ') }))));
    const box = $('#stage').getBoundingClientRect(), w = tip.offsetWidth || 240, hh = tip.offsetHeight || 60;
    tip.style.left = clamp(pt.x + 18, 10, box.width - w - 10) + 'px';
    tip.style.top = clamp(pt.y - hh - 12, 10, box.height - hh - 10) + 'px';
    tip.classList.add('show');
  }

  /* -------------------------------------------------------------------- select */

  function select(q, o) {
    o = o || {};
    S.selected = q; showTip(null);
    const sp = stage.layer.get(q.id);
    stage.select(sp || null);
    [boardList, searchList].forEach(l => { l.setSelected(q.id); });
    activeList().setCursor(q.id, o.from !== 'list');
    App.detail.open(q, { opener: o.opener, analyze: o.analyze });
    stage.focusQuake(q);
  }
  App.on('detail', q => { if (!q) { S.selected = null; stage.select(null); boardList.setSelected(null); searchList.setSelected(null); } });
  App.on('open', q => select(q, { from: 'detail' }));
  App.on('focus', q => stage.focusQuake(q));

  /* -------------------------------------------------------------------- search */

  const popular = ['Japan', 'Chile', 'California', 'Indonesia', 'Turkey', 'New Zealand', 'Greece', 'Ring of Fire'];
  function showSearchIntro() {
    searchList.empty({ title: 'Search the world', text: 'Type a country or region above, or pick one. Names like “Japan”, “Aegean” or “East African Rift” search the whole area, including offshore.',
      suggestions: popular.map(p => ({ label: p, query: p })), onPick: s => runSearch(s.query) });
    $('#search-status').textContent = '';
  }

  function searchParams(o) {
    const s = App.settings;
    return { minMag: o && o.minMag != null ? o.minMag : s.searchMinMag, days: o && o.days != null ? o.days : s.days, strict: o && o.strict != null ? !!o.strict : s.strict };
  }
  function syncSearchFilters(p) {
    p = p || searchParams();
    searchMag.set(p.minMag); $('#f-strict').checked = !!p.strict;
    segDays.set([1, 7, 30, 90, 365].indexOf(p.days) >= 0 ? p.days : '');
    radiusRange.set(App.settings.homeRadiusKm);
    $('#f-radius-wrap').hidden = !S.search.near;
    $('#f-strict').closest('.filter').hidden = S.search.near;
  }

  async function runSearch(text, o) {
    text = String(text || '').trim(); if (!text) return;
    const sr = S.search, params = searchParams(o), token = ++sr.token;
    Object.assign(sr, { loading: true, error: '', query: text, near: false, params });
    syncSearchFilters(params);
    $('#q').value = text; closeSuggest();
    $('#search').classList.add('busy');
    setTab('search');
    if (!sr.res) searchList.skeleton(6); else searchList.flash(true);
    try {
      const res = await QB.service.searchPlace(text, { minMag: params.minMag, days: params.days, strict: params.strict, limit: 500 });
      if (token !== sr.token) return;
      applyResults(res);
    } catch (e) {
      if (token !== sr.token) return;
      sr.error = e.message; searchList.flash(false);
      if (!sr.res) searchList.error(e.message, () => runSearch(text, o));
      else App.toast({ title: 'Search failed', body: e.message, icon: 'alert' });
    } finally {
      if (token === sr.token) { sr.loading = false; $('#search').classList.remove('busy'); }
    }
  }
  async function runNear(o) {
    const home = App.settings.home;
    if (!home) { App.homePopover(() => runNear(o)); return; }
    const sr = S.search, params = searchParams(o), token = ++sr.token, radius = App.settings.homeRadiusKm;
    Object.assign(sr, { loading: true, error: '', query: 'near ' + home.name, near: true, params });
    syncSearchFilters(params); $('#q').value = ''; closeSuggest(); $('#search').classList.add('busy');
    setTab('search');
    if (!sr.res) searchList.skeleton(6); else searchList.flash(true);
    try {
      const res = await QB.service.near(home.lat, home.lon, { radiusKm: radius, minMag: params.minMag, days: params.days, label: home.name, limit: 500 });
      if (token !== sr.token) return;
      applyResults(res);
    } catch (e) {
      if (token !== sr.token) return;
      searchList.flash(false); if (!sr.res) searchList.error(e.message, () => runNear(o)); else App.toast({ title: 'Search failed', body: e.message, icon: 'alert' });
    } finally { if (token === sr.token) { sr.loading = false; $('#search').classList.remove('busy'); } }
  }
  function rerunSearch() {
    clearTimeout(rerunSearch.t);
    rerunSearch.t = setTimeout(() => { const sr = S.search; if (!sr.query) return; if (sr.near) runNear(); else runSearch(sr.query.replace(/^near /, '')); }, 380);
  }

  function applyResults(res) {
    const sr = S.search; sr.res = res;
    searchList.flash(false);
    $('#count-search').textContent = res.total > res.quakes.length ? QB.fmt.int(res.total) : String(res.quakes.length);
    renderSearch();
    renderDataset({ cascade: true });
    if (res.center) stage.showCircle(res.center, res.radiusKm);
    else if (res.key) stage.showRegion(QB.regions.boxesFor(res.key), res.bounds);
    else stage.clearRegion();
    writeHash(); paintSaveButton();
    App.say(res.label + ': ' + plural(res.total, 'event') + ' found.');
  }

  function renderSearch() {
    const sr = S.search, res = sr.res; if (!res) return;
    const p = sr.params;
    if (!res.quakes.length) {
      // Only a free-text query can be a near miss for a place name. A recognised region that came back
      // empty is a question of magnitude and dates, not spelling.
      const q = norm(sr.query);
      const tips = res.how !== 'text' ? [] : QB.regions.suggest(sr.query, 6)
        .filter(k => k.indexOf(q) >= 0 || QB.regions.ratio(k, q) >= 0.7).slice(0, 4)
        .map(k => ({ label: QB.regions.displayName(k), query: k }));
      const span = QB.fmt.num(p.days) + (p.days === 1 ? ' day' : ' days');
      const why = res.how === 'text'
        ? 'No event names \u201c' + res.label + '\u201d in its place, at M' + p.minMag.toFixed(1) + '+ over ' + span + '. Try a country or region name, lower the magnitude, or look further back.' + (tips.length ? ' Did you mean:' : '')
        : 'Nothing at M' + p.minMag.toFixed(1) + '+ in ' + span + ' for \u201c' + res.label + '\u201d. Lower the magnitude or look further back.';
      searchList.empty({ title: 'No events found', text: why, suggestions: tips, onPick: s => runSearch(s.query) });
    } else searchList.render(res.quakes, listCtx(true));
    const st = clear($('#search-status')), bits = [];
    bits.push(h('b', { text: res.truncated ? 'Showing ' + QB.fmt.int(res.quakes.length) + ' of ' + QB.fmt.int(res.total) : plural(res.quakes.length, 'event') }));
    bits.push(' · ' + res.note);
    if (res.stale) bits.push(h('span', { class: 'chip', 'data-c': 'warn' }, icon('offline'), 'cached copy'));
    if (res.scanned) bits.push(' · scanned ' + QB.fmt.int(res.scanned));
    st.append(h('span', { class: 'grow', title: res.note }, bits), h('button', { class: 'chip-btn', type: 'button', onclick: clearSearch }, icon('close'), 'Clear'));
    if (S.selected) searchList.setSelected(S.selected.id);
  }
  function clearSearch() {
    const sr = S.search; sr.token++;
    Object.assign(sr, { res: null, query: '', near: false, error: '', loading: false });
    $('#count-search').textContent = '–'; $('#search').classList.remove('busy');
    showSearchIntro(); syncSearchFilters(); writeHash(); paintSaveButton();
    stage.clearRegion(); setTab('board'); stage.resetView();
  }

  /* -------------------------------------------------------------- saved searches */

  const norm = QB.regions.normalize;
  const savedIndex = () => { const q = S.search.near ? null : norm(S.search.query); return q ? App.settings.bookmarks.findIndex(b => norm(b.query) === q) : -1; };
  function paintSaveButton() {
    const b = $('#btn-save'), show = !!(S.search.res && !S.search.near && S.tab === 'search');
    b.hidden = !show; if (!show) return;
    const on = savedIndex() >= 0;
    clear(b).append(icon(on ? 'star-fill' : 'star')); b.setAttribute('aria-pressed', String(on));
    b.setAttribute('aria-label', on ? 'Remove this saved search' : 'Save this search'); b.title = on ? 'Remove from saved searches (B)' : 'Save this search (B)';
  }
  function toggleSave() {
    const sr = S.search; if (!sr.res || sr.near) return;
    const i = savedIndex(), marks = App.settings.bookmarks.slice();
    if (i >= 0) { marks.splice(i, 1); App.set({ bookmarks: marks }); App.toast({ title: 'Removed “' + sr.res.label + '”', icon: 'check', life: 2200 }); }
    else {
      if (marks.length >= 9) return App.toast({ title: 'You can save up to 9 searches', body: 'Remove one first.', icon: 'alert' });
      marks.unshift({ query: sr.query, minMag: sr.params.minMag, days: sr.params.days, strict: sr.params.strict });
      App.set({ bookmarks: marks }); App.toast({ title: 'Saved “' + sr.res.label + '”', body: 'Press 1 to come back to it.', icon: 'star-fill', life: 3000 });
    }
  }
  function renderSaved() {
    const marks = App.settings.bookmarks, nav = $('#saved'), box = clear($('#saved-chips'));
    nav.hidden = !marks.length;
    marks.forEach((m, i) => {
      const active = S.tab === 'search' && !S.search.near && norm(S.search.query) === norm(m.query);
      box.append(h('div', { class: 'saved-chip', 'aria-current': active ? 'true' : null },
        h('button', { class: 'main', type: 'button', title: 'Open (key ' + (i + 1) + ')', onclick: () => openSaved(i) },
          h('kbd', { text: String(i + 1) }), h('span', { text: QB.regions.resolve(m.query) ? QB.regions.displayName(QB.regions.resolve(m.query).key) : m.query }),
          h('span', { class: 'meta', text: 'M' + (m.minMag != null ? m.minMag.toFixed(1) : '2.5') + '+ · ' + (m.days != null ? QB.fmt.num(m.days) : '30') + 'd' })),
        h('button', { class: 'x', type: 'button', 'aria-label': 'Remove ' + m.query, onclick: e => { e.stopPropagation(); const a = App.settings.bookmarks.slice(); a.splice(i, 1); App.set({ bookmarks: a }); } }, icon('close'))));
    });
  }
  function openSaved(i) { const m = App.settings.bookmarks[i]; if (m) runSearch(m.query, m); }

  /* ------------------------------------------------------------------- hash */

  function writeHash() {
    const sr = S.search; let hash = '';
    if (S.tab === 'search' && sr.query && sr.params) {
      const p = new URLSearchParams();
      if (sr.near) p.set('near', '1'); else p.set('q', sr.query);
      p.set('m', String(sr.params.minMag)); p.set('d', String(sr.params.days)); if (sr.params.strict) p.set('strict', '1');
      hash = '#' + p.toString();
    }
    try { history.replaceState(null, '', hash || location.pathname + location.search); } catch (e) { /* sandboxed frames */ }
  }
  function routeFromHash() {
    const raw = location.hash.replace(/^#/, ''); if (!raw) return;
    const p = new URLSearchParams(raw), o = {};
    if (p.get('m') != null && isFinite(p.get('m'))) o.minMag = Number(p.get('m'));
    if (p.get('d') != null && isFinite(p.get('d'))) o.days = Number(p.get('d'));
    if (p.get('strict')) o.strict = true;
    if (p.get('near')) runNear(o); else if (p.get('q')) runSearch(p.get('q').slice(0, 80), o);
  }

  /* ---------------------------------------------------------------------- tabs */

  function layoutInk() {
    const on = $('#tabs [aria-selected="true"]'); if (!on) return;
    $('#tabs').style.setProperty('--x', on.offsetLeft + 'px'); $('#tabs').style.setProperty('--w', on.offsetWidth + 'px');
    $('#tab-ink').style.transform = 'translateX(' + on.offsetLeft + 'px)'; $('#tab-ink').style.width = on.offsetWidth + 'px';
  }
  function setTab(name) {
    if (name === S.tab) { layoutInk(); return; }
    S.tab = name;
    $('#tab-board').setAttribute('aria-selected', String(name === 'board')); $('#tab-search').setAttribute('aria-selected', String(name === 'search'));
    $('#view-board').hidden = name !== 'board'; $('#view-search').hidden = name !== 'search';
    layoutInk();
    if (name === 'board') { stage.clearRegion(); stage.resetView(); }
    renderDataset({ cascade: true });
    if (name === 'search' && S.search.res) {
      const r = S.search.res;
      if (r.center) stage.showCircle(r.center, r.radiusKm); else if (r.key) stage.showRegion(QB.regions.boxesFor(r.key), r.bounds);
    }
    writeHash(); paintSaveButton(); renderSaved();
    if (S.selected) App.detail.close();
  }

  /* --------------------------------------------------------------- suggestions */

  const sug = { items: [], active: -1 };
  function openSuggest() {
    const q = $('#q').value.trim(), box = clear($('#suggest')); sug.items = []; sug.active = -1;
    const nice = text => { const hit = QB.regions.resolve(text); return hit && hit.how !== 'guess' ? QB.regions.displayName(hit.key) : text; };
    if (!q) {
      App.settings.bookmarks.slice(0, 5).forEach(m => sug.items.push({ group: 'Saved', kind: 'saved', label: nice(m.query), meta: 'M' + (m.minMag != null ? m.minMag.toFixed(1) : '2.5') + '+ \u00b7 ' + (m.days != null ? QB.fmt.num(m.days) : 30) + 'd', m, ico: 'star' }));
      popular.forEach(p => sug.items.push({ group: 'Popular places', kind: 'q', label: p, query: p, ico: 'pin' }));
      sug.items.push({ group: 'Popular places', kind: 'near', label: 'Near me', meta: App.settings.home ? App.settings.home.name : 'set your location', ico: 'locate' });
    } else {
      QB.regions.complete(q, 7).forEach(c => sug.items.push({ kind: 'q', label: c.label, query: c.key, meta: c.via ? 'matches \u201c' + c.via + '\u201d' : '', ico: 'pin', hl: q }));
      sug.items.push({ kind: 'q', label: 'Search \u201c' + q + '\u201d', query: q, meta: QB.regions.resolve(q) ? '' : 'as place text', ico: 'search', raw: true });
    }
    let lastGroup = null;
    sug.items.forEach((it, i) => {
      if (it.group && it.group !== lastGroup) { box.append(h('li', { class: 'group overline', role: 'presentation', text: it.group })); lastGroup = it.group; }
      const main = h('span', { class: 's-main' });
      if (it.hl && !it.raw) {
        const at = it.label.toLowerCase().indexOf(it.hl.toLowerCase());
        if (at >= 0) main.append(it.label.slice(0, at), h('mark', { text: it.label.slice(at, at + it.hl.length) }), it.label.slice(at + it.hl.length)); else main.textContent = it.label;
      } else main.textContent = it.label;
      const li = h('li', { role: 'option', id: 'sg' + i, 'aria-selected': 'false', onpointerdown: e => { e.preventDefault(); pickSuggest(i); } }, icon(it.ico), main, it.meta ? h('span', { class: 's-meta', text: it.meta }) : null);
      box.append(li); it.el = li;
    });
    box.hidden = false; $('#q').setAttribute('aria-expanded', 'true');
  }
  function closeSuggest() { $('#suggest').hidden = true; $('#q').setAttribute('aria-expanded', 'false'); $('#q').removeAttribute('aria-activedescendant'); sug.active = -1; }
  function moveSuggest(d) {
    if ($('#suggest').hidden) return openSuggest();
    const n = sug.items.length; if (!n) return;
    sug.active = sug.active < 0 ? (d > 0 ? 0 : n - 1) : (sug.active + d + n) % n;       // from nothing: down picks the first, up the last
    sug.items.forEach((it, i) => it.el.setAttribute('aria-selected', String(i === sug.active)));
    const el = sug.items[sug.active].el; $('#q').setAttribute('aria-activedescendant', el.id); el.scrollIntoView({ block: 'nearest' });
  }
  function pickSuggest(i) {
    const it = sug.items[i]; if (!it) return;
    closeSuggest();
    if (it.kind === 'near') runNear(); else if (it.kind === 'saved') runSearch(it.m.query, it.m); else runSearch(it.query);
  }
  const qIn = $('#q');
  qIn.addEventListener('input', openSuggest);
  qIn.addEventListener('focus', openSuggest);
  qIn.addEventListener('blur', () => setTimeout(closeSuggest, 120));
  qIn.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown') { e.preventDefault(); moveSuggest(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); moveSuggest(-1); }
    else if (e.key === 'Escape') { if (!$('#suggest').hidden) { e.stopPropagation(); closeSuggest(); } else qIn.blur(); }
  });
  $('#search').addEventListener('submit', e => {
    e.preventDefault();
    if (sug.active >= 0 && !$('#suggest').hidden) return pickSuggest(sug.active);
    const v = qIn.value.trim(); if (v) runSearch(v);
  });

  /* ------------------------------------------------------------------- replay */

  const rp = { active: false, paused: false, t0: 0, t1: 0, cur: 0, rate: 0, size: 0, lastPaint: 0, qs: [] };
  function startReplay() {
    const ds = dataset(), qs = ds.quakes.filter(q => q.timeMs != null);
    if (qs.length < 2) return App.toast({ title: 'Not enough events to replay', body: 'Widen the window or lower the magnitude.', icon: 'info', life: 3200 });
    const t0 = Math.min.apply(null, qs.map(q => q.timeMs)) - 60e3, t1 = now(), dur = clamp(qs.length * 0.5, 14, 30);
    Object.assign(rp, { active: true, paused: false, t0, t1, cur: t0, rate: (t1 - t0) / dur, qs });
    stage.layer.clock = t0; $('#replay').classList.add('active'); paintReplayBtn(); $('#rp-scrub').value = 0;
    if (S.selected) App.detail.close();
  }
  function endReplay(natural) {
    if (!rp.active) return;
    rp.active = false; stage.layer.clock = null;
    if (!natural) $('#replay').classList.remove('active');
    else setTimeout(() => { if (!rp.active) $('#replay').classList.remove('active'); }, 1800);
    renderHud(dataset());
  }
  const stopReplayIfDataChanged = () => { if (rp.active) endReplay(false); };
  function paintReplayBtn() { const b = $('#rp-toggle'); clear(b).append(icon(rp.paused || !rp.active ? 'play' : 'pause')); b.setAttribute('aria-label', rp.paused || !rp.active ? 'Play' : 'Pause'); }
  function onStageTick(dt) {
    if (!rp.active || rp.paused) return;
    rp.cur = Math.min(rp.t1, rp.cur + rp.rate * dt);
    stage.layer.advanceClock(rp.cur).forEach(sp => { const q = sp.q; if (q.tier() >= 1) seis.addBurst({ mag: q.magnitude, tier: q.tier(), label: burstLabel(q), delay: 0.05 }); });
    if (now() - rp.lastPaint > 90) {
      rp.lastPaint = now();
      $('#rp-scrub').value = String(Math.round((rp.cur - rp.t0) / (rp.t1 - rp.t0) * 1000));
      const seen = rp.qs.reduce((n, q) => n + (q.timeMs <= rp.cur ? 1 : 0), 0);
      const c = $('#rp-clock'); clear(c).append(new Date(rp.cur).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }), h('br'), h('b', { text: seen + ' / ' + rp.qs.length }));
    }
    if (rp.cur >= rp.t1) { rp.paused = true; paintReplayBtn(); endReplay(true); }
  }
  $('#rp-start').addEventListener('click', startReplay);
  $('#rp-stop').addEventListener('click', () => endReplay(false));
  $('#rp-toggle').addEventListener('click', () => {
    if (!rp.active) { startReplay(); return; }
    if (rp.cur >= rp.t1) { rp.cur = rp.t0; stage.layer.clock = rp.t0; }
    rp.paused = !rp.paused; paintReplayBtn();
  });
  $('#rp-scrub').addEventListener('input', e => {
    if (!rp.active) return;
    rp.paused = true; paintReplayBtn();
    rp.cur = rp.t0 + (Number(e.target.value) / 1000) * (rp.t1 - rp.t0); stage.layer.clock = rp.cur;
  });

  /* ---------------------------------------------------------------- stage UI */

  $('#btn-spin').addEventListener('click', () => App.set({ spin: !App.settings.spin }));
  $('#btn-fit').addEventListener('click', () => { const r = S.tab === 'search' && S.search.res; if (r && r.bounds) stage.showRegion(r.key ? QB.regions.boxesFor(r.key) : null, r.bounds); else stage.resetView(); });
  $('#btn-zin').addEventListener('click', () => stage.zoomBy(1.5));
  $('#btn-zout').addEventListener('click', () => stage.zoomBy(1 / 1.5));

  /* -------------------------------------------------------------- top-bar UI */

  $('#live').addEventListener('click', () => refreshBoard(true));
  $('#btn-theme').addEventListener('click', () => App.set({ theme: resolvedTheme() === 'dark' ? 'light' : 'dark' }));
  $('#btn-settings').addEventListener('click', () => App.openSettings());
  $('#btn-help').addEventListener('click', () => App.openHelp());
  $('#btn-near').addEventListener('click', () => runNear());
  $('#btn-save').addEventListener('click', toggleSave);
  $('#btn-export').addEventListener('click', doExport);
  $('#btn-context').addEventListener('click', doContext);
  $('#brand').addEventListener('click', e => { e.preventDefault(); if (S.tab === 'search') clearSearch(); else stage.resetView(); App.detail.close(); });
  $('#tab-board').addEventListener('click', () => setTab('board'));
  $('#tab-search').addEventListener('click', () => { setTab('search'); });
  $('#tabs').addEventListener('keydown', e => { if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { setTab(S.tab === 'board' ? 'search' : 'board'); $('#tab-' + S.tab).focus(); } });

  function doExport() {
    const ds = dataset();
    if (!ds.quakes.length) return App.toast({ title: 'Nothing to export yet', icon: 'info', life: 2600 });
    const r = App.exportCsv(ds.quakes, ds.kind === 'board' ? 'board' : ds.label, App.settings.home);
    App.toast({ title: 'Exported ' + plural(r.count, 'event'), body: r.name, icon: 'check', life: 3200 });
  }
  function doContext() {
    const ds = dataset(); let a;
    if (ds.kind === 'search' && ds.res.center) a = { center: ds.res.center, radiusKm: ds.res.radiusKm };
    else if (ds.kind === 'search' && ds.res.key) a = { query: ds.res.key };
    else if (ds.kind === 'search') return App.toast({ title: 'No area to compare', body: 'Text searches can’t be compared with the past year. Try a country or region name.', icon: 'info', life: 4200 });
    else a = {};
    App.openContext(Object.assign({ label: ds.label, minMag: Math.max(ds.minMag, 2.5) }, a));
  }

  /* ---------------------------------------------------------------- keyboard */

  const typing = t => t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
  document.addEventListener('keydown', e => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (document.querySelector('dialog[open]')) return;
    const k = e.key;
    if (k === 'Escape') {
      if (rp.active) { endReplay(false); return; }
      if (App.detail.isOpen()) { App.detail.close(); return; }
      App.closePopover && App.closePopover(); return;
    }
    if (typing(e.target)) return;
    const list = activeList();
    const lower = k.toLowerCase();
    if (k === '/') { e.preventDefault(); qIn.focus(); qIn.select(); }
    else if (k === '?') App.openHelp();
    else if (k === ',') App.openSettings();
    else if (lower === 'g') App.set({ view: App.settings.view === 'globe' ? 'flat' : 'globe' });
    else if (lower === 's') App.set({ spin: !App.settings.spin });
    else if (lower === 'r') refreshBoard(true);
    else if (lower === 't') { const o = QB.FEED_ORDER; App.set({ period: o[(o.indexOf(App.settings.period) + 1) % o.length] }); }
    else if (lower === 'n') runNear();
    else if (lower === 'p') (rp.active ? $('#rp-toggle').click() : startReplay());
    else if (lower === 'e') doExport();
    else if (lower === 'x') doContext();
    else if (lower === 'b') toggleSave();
    else if (lower === 'c') { if (S.search.res) clearSearch(); }
    else if (lower === 'd') $('#btn-theme').click();
    else if (k === '[') setTab('board');
    else if (k === ']') setTab('search');
    else if (k === '+' || k === '=') stage.zoomBy(1.5);
    else if (k === '-' || k === '_') stage.zoomBy(1 / 1.5);
    else if (/^[1-9]$/.test(k)) openSaved(Number(k) - 1);
    else if (lower === 'j' || k === 'ArrowDown') { e.preventDefault(); moveCursor(1); }
    else if (lower === 'k' || k === 'ArrowUp') { e.preventDefault(); moveCursor(-1); }
    else if (k === 'Enter') { const q = list.items.find(x => x.id === list.curId); if (q) select(q, { from: 'list' }); }
    else if (lower === 'a') { const q = S.selected || list.items.find(x => x.id === list.curId); if (q) { if (App.detail.current && App.detail.current.id === q.id) App.detail.analyze(); else select(q, { analyze: true }); } }
    else if (lower === 'o') { const q = S.selected || list.items.find(x => x.id === list.curId); if (q && q.safeUrl()) window.open(q.safeUrl(), '_blank', 'noopener'); }
  });
  function moveCursor(d) {
    const list = activeList(), items = list.items; if (!items.length) return;
    let i = items.findIndex(q => q.id === list.curId);
    i = clamp(i < 0 ? (d > 0 ? 0 : items.length - 1) : i + d, 0, items.length - 1);
    if (i >= list.limit) list.grow();
    list.setCursor(items[i].id, true);
    const sp = stage.layer.get(items[i].id); stage.layer.hoverId = sp ? sp.id : null;
  }

  /* --------------------------------------------------- settings -> the world */

  function syncBoardFilters() {
    const s = App.settings;
    boardMag.set(s.minMag); segPeriod.set(s.period);
  }
  let reloadTimer = 0;
  function reloadBoardSoon() {
    clearTimeout(reloadTimer);
    S.board.first = true; boardList.flash(true);
    reloadTimer = setTimeout(() => { S.board.fetching = false; refreshBoard(false); }, 320);
  }
  App.on('settings', changed => {
    const has = k => changed.indexOf(k) >= 0, s = App.settings;
    if (has('theme')) applyTheme();
    if (has('motion') || has('spin')) { applyMotion(); $('#btn-spin').setAttribute('aria-pressed', String(s.spin && !FX.reducedMotion())); }
    if (has('dayNight')) stage.setDayNight(s.dayNight);
    if (has('view')) { $('#stage').dataset.mode = s.view; stage.setMode(s.view); segMode.set(s.view); }
    if (has('minMag') || has('period')) { syncBoardFilters(); if (S.board.loaded || S.board.fetching) reloadBoardSoon(); if (S.tab === 'board') renderHud(dataset()); }
    if (has('interval')) { S.nextRefresh = Math.min(S.nextRefresh, S.lastStart + s.interval * 1000); }
    if (has('home') || has('homeRadiusKm')) {
      stage.setHome(s.home); syncSearchFilters(S.search.params);
      renderBoard(); if (S.search.res) renderSearch();
      if (has('home') && App.detail.current) App.detail.open(App.detail.current, {});
    }
    if (has('bookmarks')) { renderSaved(); paintSaveButton(); }
    if (has('alertRegions')) S.alertBoxes = [].concat(...s.alertRegions.map(k => QB.regions.boxesFor(k)));
    if (has('searchMinMag') || has('days') || has('strict')) { if (!S.search.loading) syncSearchFilters(S.search.params || searchParams()); }
  });

  /* -------------------------------------------------------------------- loops */

  function secondTick() {
    const t = now();
    [boardList, searchList].forEach(l => l.tickAges());
    if (S.board.loaded) renderKpisQuiet();
    if (t >= S.nextRefresh && !S.board.fetching && navigator.onLine !== false) refreshBoard(false);
  }
  /* Ages in the tiles move with the clock; the counts only when data changes. */
  function renderKpisQuiet() {
    const ds = dataset(), strongest = ds.quakes.reduce((a, q) => (!a || q.magnitude > a.magnitude ? q : a), null);
    if (strongest) $('#k-max-sub').textContent = shortPlace(strongest.place) + ' · ' + QB.fmt.age(strongest.ageSeconds());
  }
  setInterval(paintLive, 250);
  setInterval(secondTick, 1000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && now() >= S.nextRefresh && !S.board.fetching) refreshBoard(false); });
  addEventListener('online', () => { paintLive(); refreshBoard(true); });
  addEventListener('offline', paintLive);

  const seisLoop = new FX.Loop(dt => { seis.update(dt); if (seis.visible !== false && !$('#seismo').hidden) seis.draw(); });
  if (window.IntersectionObserver) {
    new IntersectionObserver(es => { stage.visible = es[0].isIntersecting; }).observe($('#stage'));
    new IntersectionObserver(es => { seis.visible = es[0].isIntersecting; }).observe($('#seismo'));
  }
  if (window.ResizeObserver) new ResizeObserver(() => { if (!$('#seismo').hidden) seis.resize(); }).observe($('#seismo'));
  addEventListener('resize', () => { layoutInk(); });

  /* ---------------------------------------------------------------------- go */

  function init() {
    const s = App.settings;
    applyMotion(); applyTheme();
    $('#stage').dataset.mode = s.view; stage.setMode(s.view); segMode.set(s.view);
    stage.setSpin(s.spin && !FX.reducedMotion()); stage.setDayNight(s.dayNight); stage.setHome(s.home);
    $('#btn-spin').setAttribute('aria-pressed', String(s.spin));
    S.alertBoxes = [].concat(...s.alertRegions.map(k => QB.regions.boxesFor(k)));
    syncBoardFilters(); syncSearchFilters(); renderSaved(); showSearchIntro();
    boardList.skeleton(7);
    stage.start(); seisLoop.start();
    Land.load().then(land => { stage.setLand(land); }).catch(err => { console.warn('map data unavailable', err); $('#stage-note').hidden = false; $('#stage-note').textContent = 'Map outlines couldn’t be loaded; events are still plotted.'; });
    S.nextRefresh = now();
    refreshBoard(false).then(() => routeFromHash());
    requestAnimationFrame(() => { layoutInk(); segMode.place(); segPeriod.place(); segDays.place(); });
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { layoutInk(); });
  }
  init();
})(self);
