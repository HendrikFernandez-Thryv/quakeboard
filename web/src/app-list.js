/* The event list. Rows are keyed by event id and reused between renders, so
   a refresh updates text in place, only brand-new events animate in, and the
   rows they push down glide rather than jump. */
(function (global) {
  'use strict';
  const QB = global.QB, FX = global.QBFX, App = global.App;
  const { h, icon, clear, plural } = App;

  const PAGER = { green: 'ok', yellow: 'warn', orange: 'serious', red: 'bad' };

  function chipsFor(q, fresh) {
    const out = [];
    if (fresh) out.push(h('span', { class: 'chip chip-new', text: 'NEW' }));
    if (q.tsunami) out.push(h('span', { class: 'chip', 'data-c': 'bad', title: 'Tsunami flag set by USGS. Not an official warning.' }, icon('alert'), 'Tsunami flag'));
    if (q.alert) out.push(h('span', { class: 'chip', 'data-c': PAGER[q.alert] || 'warn', title: 'USGS PAGER estimated impact' }, icon('shield'), 'PAGER ' + q.alert));
    if (q.felt) out.push(h('span', { class: 'chip', title: 'Felt reports submitted to USGS' }, icon('users'), q.felt.toLocaleString('en-US') + ' felt'));
    if (q.etype && q.etype !== 'earthquake') out.push(h('span', { class: 'chip', text: q.etype.replace(/_/g, ' ') }));
    return out;
  }

  class List {
    /* `o.onOpen(quake)` runs on click; `o.kind` is 'board' or 'search'. */
    constructor(ul, o) {
      this.ul = ul; this.o = o || {}; this.rows = new Map(); this.items = []; this.ctx = {};
      this.limit = 60; this.selId = null; this.curId = null; this.more = null;
      ul.addEventListener('click', e => {
        const li = e.target.closest('.row'); if (!li || !li._q) return;
        if (this.o.onOpen) this.o.onOpen(li._q, li);
      });
      if (window.IntersectionObserver) {
        this.io = new IntersectionObserver(es => { if (es.some(x => x.isIntersecting)) this.grow(); }, { root: ul, rootMargin: '240px' });
      }
    }
    grow() { this.limit += 80; this.render(this.items, this.ctx); }

    make(q) {
      const r = {
        mag: h('b'), type: h('small'), place: h('div', { class: 'place' }),
        age: h('span', { class: 'age' }), depth: h('span', { class: 'num' }), when: h('span'),
        chips: h('div', { class: 'chips' }), dist: h('div', { class: 'dist' }),
      };
      const li = h('li', { class: 'row', role: 'option', tabindex: '-1', 'aria-selected': 'false', dataset: { id: q.id } },
        h('i', { class: 'bar' }),
        h('div', { class: 'mag' }, r.mag, r.type),
        h('div', { class: 'main' }, r.place, h('div', { class: 'sub' }, r.age, r.depth, r.when)),
        h('div', { class: 'side' }, r.chips, r.dist));
      li._r = r; li._q = q;
      return li;
    }
    update(li, q, ctx) {
      const r = li._r; li._q = q;
      const tier = q.tier();
      if (li._tier !== tier) { li.classList.remove('t0', 't1', 't2', 't3', 't4'); li.classList.add('t' + tier); li._tier = tier; }
      const set = (el, text) => { if (el._t !== text) { el._t = text; el.textContent = text; } };
      set(r.mag, q.magText()); set(r.type, q.magType || '');
      set(r.place, q.place); r.place.title = q.place;
      set(r.age, QB.fmt.age(q.ageSeconds()));
      const depth = App.depthLabel(q);
      r.depth.hidden = !depth; set(r.depth, depth || '');
      r.when.hidden = !ctx.showDate; if (ctx.showDate) set(r.when, App.whenShort(q));
      const fresh = !!(ctx.fresh && ctx.fresh(q));
      const sig = [q.tsunami, q.alert, q.felt, q.etype, fresh].join('|');
      if (li._sig !== sig) {
        li._sig = sig; clear(r.chips); chipsFor(q, fresh).forEach(c => r.chips.appendChild(c));
        if (fresh && !li._fresh) { li._fresh = true; li.classList.add('fresh'); setTimeout(() => { li.classList.remove('fresh'); li._fresh = false; }, 3600); }
      }
      let dist = '';
      if (ctx.home && q.lat != null) {
        const km = QB.geo.haversine(ctx.home.lat, ctx.home.lon, q.lat, q.lon);
        dist = QB.geo.formatKm(km) + ' ' + QB.geo.directionFrom(ctx.home.lat, ctx.home.lon, q.lat, q.lon);
      }
      set(r.dist, dist);
      const sel = q.id === this.selId;
      if (li._sel !== sel) { li._sel = sel; li.setAttribute('aria-selected', String(sel)); }
      const cur = q.id === this.curId;
      if (li._cur !== cur) { li._cur = cur; li.classList.toggle('cursor', cur); }
    }

    /* Replace what is shown. `ctx`: {fresh(q), home, showDate}. */
    render(items, ctx) {
      this.items = items; this.ctx = ctx = ctx || {};
      this.placeholders(false);
      const shown = items.slice(0, this.limit), want = new Set(shown.map(q => q.id));
      const animate = !FX.reducedMotion() && this.rows.size && this.rows.size < 140;
      const before = new Map();
      if (animate) this.rows.forEach((li, id) => { if (li.isConnected) before.set(id, li.getBoundingClientRect().top); });

      this.rows.forEach((li, id) => { if (!want.has(id)) { li.remove(); this.rows.delete(id); } });
      const firstRender = this.rows.size === 0;
      let prev = null, created = 0;
      shown.forEach((q, i) => {
        let li = this.rows.get(q.id);
        if (!li) {
          li = this.make(q); this.rows.set(q.id, li); created++;
          if (!FX.reducedMotion() && (firstRender || i < 12)) {
            li.classList.add('enter'); li.style.setProperty('--i', String(firstRender ? i : 0));
            li.addEventListener('animationend', function done(e) { if (e.target === li && e.animationName === 'rowIn') { li.classList.remove('enter'); li.removeEventListener('animationend', done); } });
          }
        }
        this.update(li, q, ctx);
        const ref = prev ? prev.nextSibling : this.ul.firstChild;
        if (ref !== li) this.ul.insertBefore(li, ref);
        prev = li;
      });

      if (animate) {
        this.rows.forEach((li, id) => {
          if (!before.has(id) || li.classList.contains('enter')) return;
          const dy = before.get(id) - li.getBoundingClientRect().top;
          if (Math.abs(dy) > 1 && li.animate) li.animate([{ transform: 'translateY(' + dy + 'px)' }, { transform: 'none' }], { duration: 560, easing: 'cubic-bezier(.2,.8,.2,1)' });
        });
      }
      this.renderMore(items.length - shown.length);
      return created;
    }
    renderMore(rest) {
      if (this.more) { if (this.io) this.io.unobserve(this.more); this.more.remove(); this.more = null; }
      if (rest <= 0) return;
      this.more = h('li', { class: 'list-more' },
        h('button', { class: 'btn btn-sm', type: 'button', onclick: () => this.grow(), text: 'Show ' + Math.min(80, rest) + ' more (' + rest.toLocaleString('en-US') + ' left)' }));
      this.ul.appendChild(this.more);
      if (this.io) this.io.observe(this.more);
    }
    /* Text that changes with time alone: ages, and nothing else. */
    tickAges() {
      const now = Date.now() / 1000;
      this.rows.forEach(li => {
        const t = QB.fmt.age(li._q.ageSeconds(now)), el = li._r.age;
        if (el._t !== t) { el._t = t; el.textContent = t; }
      });
    }
    setSelected(id) {
      this.selId = id;
      this.rows.forEach((li, rid) => { const s = rid === id; if (li._sel !== s) { li._sel = s; li.setAttribute('aria-selected', String(s)); } });
    }
    setCursor(id, scroll) {
      this.curId = id;
      this.rows.forEach((li, rid) => { const c = rid === id; if (li._cur !== c) { li._cur = c; li.classList.toggle('cursor', c); } });
      const li = this.rows.get(id);
      if (li && scroll) li.scrollIntoView({ block: 'nearest', behavior: FX.reducedMotion() ? 'auto' : 'smooth' });
    }
    flash(on) { this.ul.classList.toggle('loading', !!on); }

    /* ---- placeholders: skeleton while there is nothing to hold, else empty/error ---- */
    placeholders(show) { if (!show) this.ph && (this.ph.remove(), this.ph = null); }
    reset() { this.rows.forEach(li => li.remove()); this.rows.clear(); this.items = []; this.renderMore(0); }
    skeleton(n) {
      this.reset(); this.placeholders(false);
      const frag = document.createDocumentFragment();
      for (let i = 0; i < (n || 7); i++) {
        frag.appendChild(h('li', { class: 'row skel', 'aria-hidden': 'true' },
          h('div', { class: 'mag' }, h('span', { class: 'sk', style: { width: '54px', height: '54px', borderRadius: '16px' } })),
          h('div', { class: 'main' }, h('span', { class: 'sk', style: { width: (52 + (i * 13) % 34) + '%', height: '15px', marginBottom: '8px' } }), h('span', { class: 'sk', style: { width: '36%', height: '11px' } })),
          h('div', { class: 'side' }, h('span', { class: 'sk', style: { width: '58px', height: '20px', borderRadius: '999px' } }))));
      }
      this.ph = h('li', { class: 'ph', 'aria-hidden': 'true', style: { display: 'contents' } }); this.ph.appendChild(frag);
      this.ul.appendChild(this.ph);
    }
    message(node) { this.reset(); this.placeholders(false); this.ph = h('li', { class: 'ph', style: { display: 'block' } }, node); this.ul.appendChild(this.ph); }
    empty(o) {
      const art = h('div', { class: 'empty-art', 'aria-hidden': 'true' }, h('i'), h('i'), h('i'));
      const box = h('div', { class: 'empty' }, art, h('h3', { text: o.title }), o.text ? h('p', { text: o.text }) : null,
        o.suggestions && o.suggestions.length ? h('div', { class: 'suggs' }, o.suggestions.map(s =>
          h('button', { class: 'sugg', type: 'button', text: s.label, onclick: () => o.onPick(s) }))) : null);
      this.message(box);
    }
    error(message, onRetry) {
      this.message(h('div', { class: 'err', role: 'alert' }, icon('alert'),
        h('div', null, h('b', { text: 'Couldn’t reach the USGS' }), h('span', { text: message }), h('br'),
          onRetry ? h('button', { class: 'btn btn-sm', type: 'button', onclick: onRetry, text: 'Try again' }) : null)));
    }
  }

  App.List = List;
  App.chipsFor = chipsFor;
})(self);
