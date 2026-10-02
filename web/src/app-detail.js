/* Event detail: the facts about one earthquake, and on request the sequence
   of foreshocks and aftershocks around it. */
(function (global) {
  'use strict';
  const QB = global.QB, FX = global.QBFX, C = global.QBCharts, App = global.App;
  const { $, h, icon, clear, plural } = App;
  const SVGNS = 'http://www.w3.org/2000/svg';

  const panel = $('#panel'), detail = $('#detail'), scroller = $('#detail-scroll');
  let current = null, opener = null, token = 0;

  const isOpen = () => detail.classList.contains('open');
  const svg = (tag, attrs) => { const e = document.createElementNS(SVGNS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); return e; };

  function depthClass(km) {
    if (km == null) return '';
    return km < 70 ? 'shallow' : km < 300 ? 'intermediate' : 'deep';
  }
  function coords(q) {
    if (q.lat == null) return 'unknown';
    return Math.abs(q.lat).toFixed(3) + '° ' + (q.lat < 0 ? 'S' : 'N') + ', ' + Math.abs(q.lon).toFixed(3) + '° ' + (q.lon < 0 ? 'W' : 'E');
  }
  function fact(label, value, o) {
    o = o || {};
    return h('div', { class: 'fact' + (o.wide ? ' wide' : '') }, h('dt', { text: label }),
      h('dd', { style: o.mono ? { fontFamily: 'var(--mono)', fontSize: '13px' } : null }, value, o.note ? h('span', { class: 'sub-note', text: ' ' + o.note }) : null));
  }

  function open(q, o) {
    o = o || {};
    current = q; opener = o.opener || document.activeElement; token++;
    render(q);
    panel.classList.add('detail-open'); detail.classList.add('open'); detail.setAttribute('aria-hidden', 'false');
    requestAnimationFrame(() => { const b = $('#d-back'); if (b) b.focus({ preventScroll: true }); });
    if (o.analyze) setTimeout(() => analyze(), 380);
    App.emit('detail', q);
  }
  function close() {
    if (!isOpen()) return;
    token++; current = null;
    panel.classList.remove('detail-open'); detail.classList.remove('open'); detail.setAttribute('aria-hidden', 'true');
    C && App.chartTip(null);
    if (opener && opener.isConnected && opener.focus) opener.focus({ preventScroll: true });
    App.emit('detail', null);
  }

  function render(q) {
    clear(scroller);
    scroller.className = 'detail-scroll t' + q.tier();
    scroller.scrollTop = 0;

    // magnitude ring: fills to M/9, a decorative meter; the number is the data
    const R = 46, CIRC = 2 * Math.PI * R;
    const ring = svg('svg', { viewBox: '0 0 104 104', 'aria-hidden': 'true' });
    const fill = svg('circle', { class: 'fill', cx: 52, cy: 52, r: R, 'stroke-dasharray': CIRC, 'stroke-dashoffset': CIRC });
    ring.append(svg('circle', { class: 'track', cx: 52, cy: 52, r: R }), fill);
    const magEl = h('b', { text: q.mag == null ? '?' : '0.0' });
    if (q.mag != null) FX.countUp(magEl, q.mag, { from: 0, duration: 1100, format: v => v.toFixed(1) });
    requestAnimationFrame(() => requestAnimationFrame(() => {
      fill.style.strokeDashoffset = q.mag == null ? CIRC : CIRC * (1 - Math.min(1, Math.max(0, q.mag) / 9));
    }));
    const when = App.whenShort(q) + ' · ' + QB.fmt.age(q.ageSeconds());
    scroller.append(h('div', { class: 'd-hero' },
      h('div', { class: 'd-mag', role: 'img', 'aria-label': 'Magnitude ' + q.magText() }, ring, magEl, h('small', { text: q.magType || 'mag' })),
      h('div', { style: { minWidth: 0 } }, h('h2', { class: 'd-title', id: 'd-title', text: q.place }), h('p', { class: 'd-sub', text: when }))));

    const chips = App.chipsFor(q, false);
    chips.push(h('span', { class: 'chip', 'data-c': q.status === 'reviewed' ? 'ok' : undefined, title: q.status === 'reviewed' ? 'Checked by a seismologist' : 'Automatic solution; may change' },
      icon(q.status === 'reviewed' ? 'check' : 'info'), q.status === 'reviewed' ? 'Reviewed' : 'Automatic'));
    scroller.append(h('div', { class: 'd-chips' }, chips));

    const home = App.settings.home, facts = h('dl', { class: 'facts' });
    facts.append(fact('Coordinates', coords(q)),
      fact('Depth', q.depthText(), { note: depthClass(q.depthKm) }));
    if (home && q.lat != null) {
      const km = QB.geo.haversine(home.lat, home.lon, q.lat, q.lon), br = QB.geo.bearing(home.lat, home.lon, q.lat, q.lon);
      const arrow = svg('svg', { class: 'ico ico-fill compass', viewBox: '0 0 24 24', 'aria-hidden': 'true' });
      arrow.append(svg('use', { href: '#i-arrow' }));
      arrow.style.setProperty('--deg', '0deg');
      requestAnimationFrame(() => requestAnimationFrame(() => arrow.style.setProperty('--deg', br.toFixed(0) + 'deg')));
      facts.append(fact('From ' + home.name, h('span', null, arrow, QB.geo.formatKm(km) + ' ' + QB.geo.compass(br))));
    }
    facts.append(fact('Local time', q.localTime()), fact('UTC', q.utcTime()),
      fact('Shaking intensity', q.cdi != null || q.mmi != null ? 'CDI ' + (q.cdi != null ? q.cdi : '–') + ' · MMI ' + (q.mmi != null ? q.mmi : '–') : 'not reported'),
      fact('Significance', q.sig != null ? String(q.sig) : '–', { note: 'of ~1000' }),
      fact('Source', (q.net || '–').toUpperCase() + (q.status ? ' · ' + q.status : '')),
      fact('Event ID', q.id, { mono: true, wide: true }));
    scroller.append(facts);

    const url = q.safeUrl();
    scroller.append(h('div', { class: 'd-actions' },
      h('button', { class: 'btn btn-primary', type: 'button', id: 'd-analyze', onclick: () => analyze() }, icon('activity'), 'Analyze aftershocks'),
      h('button', { class: 'btn', type: 'button', onclick: () => App.emit('focus', q) }, icon('pin'), 'Show on map'),
      url ? h('a', { class: 'btn', href: url, target: '_blank', rel: 'noopener noreferrer' }, 'USGS page', icon('external')) : null));

    scroller.append(h('section', { class: 'seq', id: 'seq', 'aria-live': 'polite' },
      h('div', { class: 'seq-head' }, h('h3', { text: 'Aftershock sequence' })),
      h('p', { class: 'seq-lead', text: 'Find the foreshocks and aftershocks around this event, see whether the rate is decaying, and compare its size with the usual pattern.' })));
  }

  /* --------------------------------------------------------------- sequence */

  async function analyze() {
    const q = current; if (!q) return;
    const my = ++token, host = $('#seq'), btn = $('#d-analyze');
    if (!host) return;
    if (btn) { btn.disabled = true; btn.lastChild.textContent = 'Analyzing…'; }
    host.classList.add('loading');
    try {
      const seq = await QB.service.sequence(q);
      if (my !== token || current !== q) return;
      show(host, seq);
      App.say(seq.verdict());
    } catch (e) {
      if (my !== token) return;
      const msg = e && e.message ? e.message : 'something went wrong';
      host.append(h('div', { class: 'err', role: 'alert' }, icon('alert'), h('div', null, h('b', { text: 'Couldn’t analyze this event' }), h('span', { text: msg }))));
    } finally {
      host.classList.remove('loading');
      if (btn && my === token) { btn.disabled = false; btn.lastChild.textContent = 'Analyze again'; }
    }
  }

  function kv(label, value, small) {
    return h('div', null, h('dt', { text: label }), h('dd', null, String(value), small ? h('small', { text: ' ' + small }) : null));
  }

  function show(host, seq) {
    clear(host);
    const main = seq.main, big = seq.largest, fore = seq.largestForeshock, gap = seq.bathGap();
    host.append(h('div', { class: 'seq-head' }, h('h3', { text: 'Aftershock sequence' }),
      h('span', { class: 'note', text: QB.geo.formatKm(seq.radiusKm) + ' radius · M' + seq.minMag.toFixed(1) + '+' })));

    host.append(h('dl', { class: 'kv' },
      kv('Foreshocks', seq.foreshocks.length, fore ? 'M' + fore.magText() + ' max' : ''),
      kv('Aftershocks', seq.aftershocks.length, big ? 'M' + big.magText() + ' max' : ''),
      kv('Size gap', gap == null ? '–' : gap.toFixed(1), 'Båth ≈ 1.2'),
      kv('First 24 h', seq.rateFirstDay()),
      kv('Last 24 h', seq.rateLastDay()),
      kv('Days since', seq.elapsedDays().toFixed(seq.elapsedDays() < 10 ? 1 : 0))));

    host.append(h('div', { class: 'callout', role: 'note' }, icon('info'), h('p', { text: seq.verdict() })));
    if (seq.stale) host.append(h('p', { class: 'chart-note', text: 'Shown from a saved copy: the network was unavailable.' }));

    if (!seq.foreshocks.length && !seq.aftershocks.length) return;

    // chart 1: magnitude against time
    const toggle1 = h('button', { class: 'chip-btn', type: 'button', 'aria-pressed': 'false', title: 'Show the same data as a table' }, icon('table'), 'Table');
    const canvas = h('canvas', { role: 'img', 'aria-label': 'Scatter chart of ' + plural(seq.aftershocks.length + seq.foreshocks.length, 'nearby event') + ' by magnitude and time since the mainshock. The same data is available as a table.' });
    const tableWrap = h('div', { class: 'table-wrap', hidden: true });
    const box1 = h('figure', { class: 'chartbox' },
      h('div', { class: 'chart-head' }, h('div', null, h('h4', { text: 'Magnitude over time' }), h('small', { text: 'Each dot is an event; the star is the mainshock' })), toggle1),
      canvas, tableWrap);
    host.append(box1);
    requestAnimationFrame(() => {
      const chart = new C.TimelineChart(canvas, {
        onHover(p, x, y) {
          if (!p) return App.chartTip(null);
          const q = p.quake, sign = p.days < 0 ? '−' : '+';
          App.chartTip(['M' + q.magText() + ' · ' + q.place, App.whenShort(q) + ' (' + sign + QB.fmt.span(Math.abs(p.days) * 86400) + ')',
                        p.km == null ? '' : QB.geo.formatKm(p.km) + ' ' + QB.geo.compass(p.bearing) + ' of the mainshock'], x, y);
        },
      });
      chart.set(main, seq.points(), seq.elapsedDays());
      App.on('theme', () => chart.draw());
      const rows = seq.points().slice(0, 300).map(p => [
        (p.days < 0 ? '−' : '+') + QB.fmt.span(Math.abs(p.days) * 86400), p.quake.magText(), p.quake.place, p.km == null ? '–' : QB.geo.formatKm(p.km)]);
      tableWrap.append(C.dataTable([{ label: 'Time' }, { label: 'Mag', num: true }, { label: 'Place' }, { label: 'From mainshock', num: true }], rows,
        'Events near the mainshock, by time' + (seq.points().length > 300 ? ' (first 300)' : '')));
      toggle1.addEventListener('click', () => {
        const on = tableWrap.hidden; tableWrap.hidden = !on; canvas.hidden = on;
        toggle1.setAttribute('aria-pressed', String(on)); toggle1.lastChild.textContent = on ? 'Chart' : 'Table';
        if (!on) chart.resize(), chart.draw();
      });
    });

    // chart 2: aftershocks per day (only once there is more than a day to show)
    if (seq.elapsedDays() >= 1 && seq.aftershocks.length) {
      const n = Math.max(3, Math.min(14, Math.ceil(seq.elapsedDays())));
      const counts = seq.countsByDay(n), plot = h('div'), tw2 = h('div', { class: 'table-wrap', hidden: true });
      const toggle2 = h('button', { class: 'chip-btn', type: 'button', 'aria-pressed': 'false' }, icon('table'), 'Table');
      host.append(h('figure', { class: 'chartbox' },
        h('div', { class: 'chart-head' }, h('div', null, h('h4', { text: 'Aftershocks per day' }), h('small', { text: 'Counting from the moment of the mainshock' })), toggle2), plot, tw2));
      C.dailyBars(plot, counts, { onHover: (t, x, y) => App.chartTip(t ? [t] : null, x, y) });
      tw2.append(C.dataTable([{ label: 'Day' }, { label: 'Aftershocks', num: true }], counts.map((c, i) => ['Day ' + (i + 1), c]), 'Aftershocks per day'));
      toggle2.addEventListener('click', () => {
        const on = tw2.hidden; tw2.hidden = !on; plot.hidden = on;
        toggle2.setAttribute('aria-pressed', String(on)); toggle2.lastChild.textContent = on ? 'Chart' : 'Table';
      });
    }

    if (seq.aftershocks.length) {
      const top = seq.aftershocks.slice().sort((a, b) => b.magnitude - a.magnitude).slice(0, 5);
      host.append(h('h4', { class: 'overline', style: { marginTop: '18px' }, text: 'Largest aftershocks' }),
        h('div', { class: 'mini' }, top.map(q => h('div', { class: 'mini-row t' + q.tier(), role: 'button', tabindex: '0',
          onclick: () => App.emit('open', q), onkeydown: e => { if (e.key === 'Enter') App.emit('open', q); } },
          h('b', { text: q.magText() }), h('span', { text: q.place }), h('em', { text: QB.fmt.span(q.epoch - main.epoch) + ' later' })))));
    }
  }

  App.detail = { open, close, isOpen, analyze, get current() { return current; } };
  $('#d-back').addEventListener('click', close);
  $('#d-copy').addEventListener('click', async () => {
    if (!current) return;
    const url = current.safeUrl() || location.href;
    const ok = await App.copyText(url);
    App.toast({ title: ok ? 'Link copied' : 'Couldn’t copy the link', body: ok ? url : 'Your browser blocked clipboard access.', icon: ok ? 'check' : 'alert', life: 2600 });
  });
})(self);
