/* Dialogs and popovers: settings, keyboard help, the "is this unusual?"
   comparison, and the "near me" location picker. */
(function (global) {
  'use strict';
  const QB = global.QB, FX = global.QBFX, C = global.QBCharts, App = global.App;
  const { $, $$, h, icon, clear } = App;

  ['#dlg-context', '#dlg-settings', '#dlg-help'].forEach(s => App.wireDialog($(s)));

  /* ---------------------------------------------------------------- helpers */

  const row = (label, desc, control) => h('div', { class: 'set-row' },
    h('div', null, h('div', { class: 'lbl', text: label }), desc ? h('div', { class: 'desc', text: desc }) : null),
    h('div', { class: 'ctl' }, control));
  function sw(checked, onChange, label) {
    const input = h('input', { type: 'checkbox', 'aria-label': label });
    input.checked = !!checked; input.addEventListener('change', () => onChange(input.checked));
    return h('label', { class: 'switch' }, input, h('span'));
  }
  function slider(o) {
    const input = h('input', { type: 'range', min: o.min, max: o.max, step: o.step, 'aria-label': o.label });
    const val = h('span', { class: 'val' });
    input.value = o.value;
    const r = App.range(input, val, o.fmt, null, o.onChange); r.paint();
    return [input, val];
  }
  function select(options, value, onChange, label) {
    const s = h('select', { class: 'field-input', 'aria-label': label, style: { width: 'auto', minWidth: '130px' } },
      options.map(o => h('option', { value: o[0], text: o[1] })));
    s.value = String(value); s.addEventListener('change', () => onChange(s.value));
    return s;
  }
  function segControl(options, value, onChange, label) {
    const el = h('div', { class: 'seg', role: 'group', 'aria-label': label }, h('i', { class: 'thumb' }),
      options.map(o => h('button', { type: 'button', 'data-v': o[0], 'aria-pressed': String(o[0] === value), text: o[1] })));
    const ctl = App.seg(el, onChange);
    requestAnimationFrame(ctl.place);
    return el;
  }

  /* --------------------------------------------------------------- settings */

  function openSettings(focus) {
    const s = App.settings, body = clear($('#set-body'));

    body.append(h('section', { class: 'set-group' }, h('h3', { class: 'overline', text: 'Live board' }),
      row('Minimum magnitude', 'Events below this are left off the board.', slider({ min: 2.5, max: 7, step: 0.1, value: s.minMag, label: 'Board minimum magnitude', fmt: v => v.toFixed(1), onChange: v => App.set({ minMag: v }) })),
      row('Time window', null, segControl([['hour', '1h'], ['day', '24h'], ['week', '7d'], ['month', '30d']], s.period, v => App.set({ period: v }), 'Board time window')),
      row('Refresh every', 'USGS updates its feeds about once a minute.', select([[15, '15 seconds'], [30, '30 seconds'], [60, '1 minute'], [120, '2 minutes'], [300, '5 minutes']], s.interval, v => App.set({ interval: Number(v) }), 'Refresh interval'))));

    body.append(h('section', { class: 'set-group' }, h('h3', { class: 'overline', text: 'Search defaults' }),
      row('Minimum magnitude', null, slider({ min: 1, max: 7, step: 0.1, value: s.searchMinMag, label: 'Search minimum magnitude', fmt: v => v.toFixed(1), onChange: v => App.set({ searchMinMag: v }) })),
      row('History', null, select([[1, '1 day'], [7, '7 days'], [30, '30 days'], [90, '90 days'], [365, '1 year']], [1, 7, 30, 90, 365].indexOf(s.days) >= 0 ? s.days : 30, v => App.set({ days: Number(v) }), 'Days of history'))));

    // alerts
    const regionBox = h('div', { class: 'chips', style: { justifyContent: 'flex-start', marginTop: '6px' } });
    const paintRegions = () => {
      clear(regionBox);
      App.settings.alertRegions.forEach(k => regionBox.append(h('span', { class: 'chip' }, QB.regions.displayName(k),
        h('button', { type: 'button', 'aria-label': 'Remove ' + QB.regions.displayName(k), style: { display: 'inline-grid', marginLeft: '2px' },
          onclick: () => { App.set({ alertRegions: App.settings.alertRegions.filter(x => x !== k) }); paintRegions(); } }, icon('close')))));
      if (!App.settings.alertRegions.length) regionBox.append(h('span', { class: 'note', text: 'Worldwide' }));
    };
    const list = h('datalist', { id: 'dl-regions' }, Object.keys(QB.regions.BOXES).sort().map(k => h('option', { value: QB.regions.displayName(k) })));
    const regionIn = h('input', { class: 'field-input', list: 'dl-regions', placeholder: 'Add a country or region…', 'aria-label': 'Add an alert region', style: { maxWidth: '230px' } });
    const addRegion = () => {
      const hit = QB.regions.resolve(regionIn.value); if (!hit) { regionIn.setCustomValidity('Unknown region'); regionIn.reportValidity(); return; }
      regionIn.setCustomValidity('');
      if (App.settings.alertRegions.indexOf(hit.key) < 0) App.set({ alertRegions: App.settings.alertRegions.concat([hit.key]) });
      regionIn.value = ''; paintRegions();
    };
    regionIn.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); addRegion(); } });
    regionIn.addEventListener('change', addRegion);
    const notifyNote = h('div', { class: 'desc' });
    const notifySwitch = sw(s.notify, async v => {
      if (v) {
        const perm = await App.askNotifyPermission();
        if (perm !== 'granted') { App.set({ notify: false }); notifySwitch.querySelector('input').checked = false; paintNotify(); return; }
      }
      App.set({ notify: v }); paintNotify();
    }, 'Desktop notifications');
    const paintNotify = () => { notifyNote.textContent = typeof Notification === 'undefined' ? 'Not supported in this browser.' : Notification.permission === 'denied' ? 'Blocked in your browser settings.' : 'Works while this tab stays open.'; };
    paintNotify();
    body.append(h('section', { class: 'set-group' }, h('h3', { class: 'overline', text: 'Alerts for new events' }),
      row('Alert at or above', 'A pop-up appears in the page. Anything lower just highlights in the list.', slider({ min: 3, max: 8, step: 0.1, value: s.alertMag, label: 'Alert magnitude', fmt: v => 'M' + v.toFixed(1), onChange: v => App.set({ alertMag: v }) })),
      row('Play a rumble', 'A short synthesised sound, louder for bigger events.', [h('button', { class: 'btn btn-sm', type: 'button', text: 'Test', onclick: () => App.rumble(Math.max(6, App.settings.alertMag)) }), sw(s.sound, v => { App.set({ sound: v }); if (v) App.rumble(6); }, 'Play a rumble')]),
      h('div', { class: 'set-row' }, h('div', null, h('div', { class: 'lbl', text: 'Desktop notifications' }), notifyNote), h('div', { class: 'ctl' }, notifySwitch)),
      h('div', null, h('div', { class: 'lbl', style: { fontWeight: 650, padding: '6px 0 2px' }, text: 'Only alert in these places' }), regionBox, h('div', { style: { marginTop: '8px' } }, regionIn, list))));
    paintRegions();

    // home
    const home = s.home || {};
    const nameIn = h('input', { class: 'field-input', value: home.name || '', placeholder: 'Home', 'aria-label': 'Name of this place' });
    const latIn = h('input', { class: 'field-input', value: home.lat != null ? home.lat : '', placeholder: '32.78', inputmode: 'decimal', 'aria-label': 'Latitude' });
    const lonIn = h('input', { class: 'field-input', value: home.lon != null ? home.lon : '', placeholder: '-96.80', inputmode: 'decimal', 'aria-label': 'Longitude' });
    const saveHome = () => {
      if (!latIn.value.trim() && !lonIn.value.trim()) return App.set({ home: null });
      try { const ll = QB.geo.parseLatLon(latIn.value + ',' + lonIn.value); latIn.setCustomValidity(''); App.set({ home: { lat: ll[0], lon: ll[1], name: nameIn.value.trim() || 'Home' } }); }
      catch (e) { latIn.setCustomValidity(e.message); latIn.reportValidity(); }
    };
    [nameIn, latIn, lonIn].forEach(i => i.addEventListener('change', saveHome));
    const locBtn = h('button', { class: 'btn btn-sm', type: 'button', onclick: () => App.locate().then(p => { if (!p) return; latIn.value = p.lat; lonIn.value = p.lon; if (!nameIn.value) nameIn.value = 'Home'; saveHome(); }) }, icon('locate'), 'Use my location');
    body.append(h('section', { class: 'set-group' }, h('h3', { class: 'overline', text: 'Home' }),
      h('p', { class: 'note', text: 'Used for “near me” searches and for distances in the list. It never leaves this browser.' }),
      h('div', { class: 'set-grid' }, h('label', { class: 'wide' }, 'Name', nameIn), h('label', null, 'Latitude', latIn), h('label', null, 'Longitude', lonIn)),
      row('Search radius', null, slider({ min: 50, max: 2000, step: 50, value: s.homeRadiusKm, label: 'Near-me radius', fmt: v => v + ' km', onChange: v => App.set({ homeRadiusKm: v }) })),
      h('div', { class: 'set-actions' }, locBtn, h('button', { class: 'btn btn-sm', type: 'button', text: 'Clear', onclick: () => { latIn.value = lonIn.value = nameIn.value = ''; App.set({ home: null }); } }))));

    body.append(h('section', { class: 'set-group' }, h('h3', { class: 'overline', text: 'Appearance' }),
      row('Theme', null, segControl([['system', 'System'], ['dark', 'Dark'], ['light', 'Light']], s.theme, v => App.set({ theme: v }), 'Theme')),
      row('Motion', 'Reduced turns off the seismograph, shockwaves and spinning.', segControl([['system', 'System'], ['full', 'Full'], ['reduced', 'Reduced']], s.motion, v => App.set({ motion: v }), 'Motion')),
      row('Spin the globe', null, sw(s.spin, v => App.set({ spin: v }), 'Spin the globe')),
      row('Day and night shading', 'Dims the land that is in darkness right now.', sw(s.dayNight, v => App.set({ dayNight: v }), 'Day and night shading'))));

    body.append(h('section', { class: 'set-group' }, h('h3', { class: 'overline', text: 'Data' }),
      h('p', { class: 'note', text: 'Everything comes straight from the USGS (earthquake.usgs.gov); this page has no server. Recent responses are kept in this browser so the board still shows something if you go offline.' }),
      h('div', { class: 'set-actions' },
        h('button', { class: 'btn btn-sm', type: 'button', onclick: () => { const n = App.clearCache(); App.toast({ title: 'Cache cleared', body: n + ' saved response' + (n === 1 ? '' : 's') + ' removed.', icon: 'check', life: 2600 }); } }, icon('trash'), 'Clear saved data'),
        h('button', { class: 'btn btn-sm', type: 'button', onclick: () => { if (confirm('Reset every setting and saved search to its default?')) { App.resetSettings(); openSettings(); } } }, 'Reset settings'))));

    App.openDialog($('#dlg-settings'));
    if (focus === 'home') setTimeout(() => latIn.scrollIntoView({ block: 'center' }), 60);
  }

  /* ------------------------------------------------------------------- help */

  const KEYS = [
    [['/'], 'Search'], [['N'], 'Search near me'], [['G'], 'Globe or flat map'], [['S'], 'Spin the globe'],
    [['P'], 'Replay the window'], [['R'], 'Refresh now'], [['T'], 'Cycle the board window'], [['['  , ']'], 'Switch tab'],
    [['J', 'K'], 'Move through the list'], [['Enter'], 'Open the selected event'], [['A'], 'Analyze aftershocks'], [['X'], 'How unusual is this?'],
    [['O'], 'Open on USGS'], [['1', '–', '9'], 'Saved searches'], [['B'], 'Save this search'], [['E'], 'Export CSV'],
    [['C'], 'Clear the search'], [['+', '−'], 'Zoom the map'], [['D'], 'Switch theme'], [[','], 'Settings'], [['?'], 'This help'], [['Esc'], 'Close or go back'],
  ];
  function openHelp() {
    const box = clear($('#help-keys'));
    KEYS.forEach(k => box.append(h('div', { class: 'key-row' }, h('span', { text: k[1] }), h('span', null, k[0].map(x => x === '–' ? '–' : h('kbd', { text: x }))))));
    App.openDialog($('#dlg-help'));
  }

  /* ---------------------------------------------------------------- context */

  async function openContext(ds) {
    const dlg = $('#dlg-context'), body = clear($('#ctx-body'));
    $('#ctx-sub').textContent = ds.label + ' · M' + ds.minMag.toFixed(1) + '+';
    body.append(h('p', { class: 'note', text: 'Comparing the last 30 days with the past year…' }),
      h('div', { class: 'sk', style: { width: '40%', height: '64px', marginTop: '14px', borderRadius: '12px' } }),
      h('div', { class: 'sk', style: { width: '100%', height: '90px', marginTop: '18px', borderRadius: '12px' } }));
    App.openDialog(dlg);
    let act;
    try {
      act = await QB.service.activity({ query: ds.query, center: ds.center, radiusKm: ds.radiusKm, minMag: ds.minMag, label: ds.label });
    } catch (e) {
      clear(body).append(h('div', { class: 'err', role: 'alert' }, icon('alert'), h('div', null, h('b', { text: 'Couldn’t compare' }), h('span', { text: e.message }))));
      return;
    }
    if (!dlg.open) return;
    clear(body);
    const ratio = act.ratio, hero = h('p', { class: 'hero' }, '–');
    body.append(h('div', { class: 'ctx-hero' }, hero,
      h('p', { class: 'unit', text: ratio == null ? 'not enough history to compare' : 'times the usual rate for ' + QB.fmt.num(act.recentDays) + ' days' })));
    if (ratio != null) FX.countUp(hero, ratio, { from: 0, duration: 1100, format: v => v.toFixed(2) + '×' });
    body.append(h('div', { class: 'callout', role: 'note' }, icon('info'), h('p', { text: act.verdict() })));

    const comp = h('div', { class: 'brows' });
    body.append(h('section', { class: 'ctx-sec' }, h('h3', { class: 'overline', text: 'Event counts' }), comp));
    C.barRows(comp, [
      { label: 'Last ' + QB.fmt.num(act.recentDays) + ' d', value: act.recent, color: 'var(--accent)', title: 'Events in the last ' + act.recentDays + ' days' },
      { label: 'Expected', value: act.expected == null ? null : Math.round(act.expected), color: 'rgb(var(--ink-rgb) / .38)', title: 'The average for a window this long over the past ' + act.baselineDays + ' days' },
    ]);
    body.append(h('div', { class: 'ctx-legend' },
      h('span', null, h('i', { style: { background: 'var(--accent)' } }), 'Actual'),
      h('span', null, h('i', { style: { background: 'rgb(var(--ink-rgb) / .38)' } }), 'Expected from the past ' + QB.fmt.num(act.baselineDays) + ' days')));

    const bandBox = h('div', { class: 'brows' });
    body.append(h('section', { class: 'ctx-sec' }, h('h3', { class: 'overline', text: 'By magnitude, last ' + QB.fmt.num(act.recentDays) + ' days' }), bandBox));
    C.barRows(bandBox, act.bands.map(b => ({
      label: b.hi == null ? 'M' + b.lo.toFixed(1) + '+' : 'M' + b.lo.toFixed(1) + '–' + (b.hi - 0.1).toFixed(1),
      value: b.n, color: 'var(--m' + (b.lo >= 6 ? 3 : b.lo >= 5 ? 2 : b.lo >= 4 ? 1 : 0) + ')',
      mark: 'var(--m' + (b.lo >= 6 ? 3 : b.lo >= 5 ? 2 : b.lo >= 4 ? 1 : 0) + ')',
    })));

    const tbl = h('div', { class: 'table-wrap', hidden: true }, C.dataTable([{ label: 'Measure' }, { label: 'Events', num: true }],
      [['Last ' + QB.fmt.num(act.recentDays) + ' days', act.recent == null ? null : QB.fmt.int(act.recent)], ['Past ' + QB.fmt.num(act.baselineDays) + ' days', act.baseline == null ? null : QB.fmt.int(act.baseline)],
       ['Expected in ' + QB.fmt.num(act.recentDays) + ' days', act.expected == null ? null : act.expected.toFixed(1)]].concat(act.bands.map(b => ['M' + b.lo.toFixed(1) + (b.hi == null ? '+' : '–' + (b.hi - 0.1).toFixed(1)), b.n == null ? null : QB.fmt.int(b.n)])), 'Counts behind the charts'));
    const tg = h('button', { class: 'chip-btn', type: 'button', 'aria-pressed': 'false', style: { marginTop: '16px' } }, icon('table'), 'View as table');
    tg.addEventListener('click', () => { tbl.hidden = !tbl.hidden; tg.setAttribute('aria-pressed', String(!tbl.hidden)); });
    body.append(tg, tbl, h('p', { class: 'note', style: { marginTop: '14px' }, text: 'Earthquakes cluster in time, so one large sequence can tilt a single month. Read this as context, not as a forecast.' }));
  }

  /* -------------------------------------------------------- near me popover */

  /* Ask the browser where we are, only when the user has clicked for it. */
  App.locate = function () {
    return new Promise(resolve => {
      if (!navigator.geolocation) { App.toast({ title: 'Location isn’t available', body: 'Enter coordinates instead.', icon: 'alert' }); return resolve(null); }
      navigator.geolocation.getCurrentPosition(
        p => resolve({ lat: Math.round(p.coords.latitude * 100) / 100, lon: Math.round(p.coords.longitude * 100) / 100 }),   // ~1 km is plenty
        err => { App.toast({ title: err.code === 1 ? 'Location permission denied' : 'Couldn’t get your location', body: 'You can type coordinates instead.', icon: 'alert' }); resolve(null); },
        { timeout: 12000, maximumAge: 600000 });
    });
  };
  let pop = null;
  function closePopover() { if (pop) { pop.remove(); pop = null; document.removeEventListener('pointerdown', outside, true); } }
  function outside(e) { if (pop && !pop.contains(e.target) && !e.target.closest('#btn-near')) closePopover(); }
  function homePopover(onDone) {
    closePopover();
    const nameIn = h('input', { class: 'field-input', placeholder: 'Home', 'aria-label': 'Name of this place' });
    const latIn = h('input', { class: 'field-input', placeholder: '32.78', inputmode: 'decimal', 'aria-label': 'Latitude' });
    const lonIn = h('input', { class: 'field-input', placeholder: '-96.80', inputmode: 'decimal', 'aria-label': 'Longitude' });
    const err = h('p', { class: 'note', style: { color: 'var(--bad)', minHeight: '0' } });
    const go = () => {
      try { const ll = QB.geo.parseLatLon(latIn.value + ',' + lonIn.value); App.set({ home: { lat: ll[0], lon: ll[1], name: nameIn.value.trim() || 'Home' } }); closePopover(); onDone(); }
      catch (e) { err.textContent = e.message; }
    };
    const here = h('button', { class: 'btn btn-sm', type: 'button', onclick: async () => { const p = await App.locate(); if (p) { latIn.value = p.lat; lonIn.value = p.lon; if (!nameIn.value) nameIn.value = 'Home'; go(); } } }, icon('locate'), 'Use my location');
    pop = h('div', { class: 'popover', role: 'dialog', 'aria-label': 'Set your location', style: { right: '0', top: 'calc(100% + 8px)' } },
      h('h3', { text: 'Where are you?' }), h('p', { class: 'note', text: 'Saved only in this browser. Used to search around you and to show distances.' }),
      h('div', { class: 'set-grid' }, h('label', { class: 'wide' }, 'Name', nameIn), h('label', null, 'Latitude', latIn), h('label', null, 'Longitude', lonIn)),
      err, h('div', { class: 'set-actions', style: { justifyContent: 'space-between' } }, here, h('button', { class: 'btn btn-primary btn-sm', type: 'button', onclick: go, text: 'Save and search' })));
    pop.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); go(); } if (e.key === 'Escape') { e.stopPropagation(); closePopover(); $('#btn-near').focus(); } });
    $('#search').appendChild(pop);
    document.addEventListener('pointerdown', outside, true);
    setTimeout(() => latIn.focus(), 30);
  }

  Object.assign(App, { openSettings, openHelp, openContext, homePopover, closePopover });
})(self);
