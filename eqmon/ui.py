"""Curses interface: a live magnitude board on top, search results below."""

import csv
import curses
import math
import os
import textwrap
import threading
import time
import webbrowser

from . import api, config, geo, map as worldmap, regions, service
from .model import humanize_age, humanize_span

BOARD = "board"
RESULTS = "results"

W_AGE = 11
W_MAG = 5
W_DEPTH = 9
W_FLAGS = 16

SPARK = "▁▂▃▄▅▆▇█"


def spark(values, ascii_only=False):
    """A tiny bar chart for a list of counts."""
    if not values:
        return ""
    top = max(values)
    if top <= 0:
        return ("." if ascii_only else SPARK[0]) * len(values)
    if ascii_only:
        ramp = " .:-=+*#"
    else:
        ramp = SPARK
    out = []
    for v in values:
        idx = int(round((len(ramp) - 1) * (float(v) / top)))
        out.append(ramp[max(0, min(len(ramp) - 1, idx))])
    return "".join(out)


class Theme(object):
    """Colour pairs, degrading gracefully on monochrome terminals."""

    def __init__(self):
        self.color = False
        try:
            self.color = curses.has_colors()
        except curses.error:
            self.color = False
        if not self.color:
            return
        curses.start_color()
        try:
            curses.use_default_colors()
            bg = -1
        except curses.error:
            bg = curses.COLOR_BLACK
        pairs = (
            (1, curses.COLOR_WHITE, bg),
            (2, curses.COLOR_YELLOW, bg),
            (3, curses.COLOR_MAGENTA, bg),
            (4, curses.COLOR_RED, bg),
            (5, curses.COLOR_WHITE, curses.COLOR_RED),
            (6, curses.COLOR_CYAN, bg),
            (7, curses.COLOR_GREEN, bg),
            (8, curses.COLOR_BLACK, curses.COLOR_CYAN),
            (9, curses.COLOR_BLACK, curses.COLOR_WHITE),
            (10, curses.COLOR_BLUE, bg),
        )
        for idx, fg, back in pairs:
            try:
                curses.init_pair(idx, fg, back)
            except curses.error:
                pass

    def pair(self, n):
        return curses.color_pair(n) if self.color else 0

    def mag(self, tier):
        if not self.color:
            return curses.A_BOLD if tier >= 3 else 0
        return {
            0: self.pair(1) | curses.A_DIM,
            1: self.pair(2),
            2: self.pair(3) | curses.A_BOLD,
            3: self.pair(4) | curses.A_BOLD,
            4: self.pair(5) | curses.A_BOLD,
        }[tier]

    @property
    def chrome(self):
        return self.pair(6) | curses.A_BOLD

    @property
    def land(self):
        return self.pair(10) | curses.A_DIM if self.color else curses.A_DIM

    @property
    def title(self):
        return self.pair(8) | curses.A_BOLD if self.color else curses.A_REVERSE

    @property
    def status(self):
        return self.pair(9) if self.color else curses.A_REVERSE

    @property
    def fresh(self):
        return self.pair(7) | curses.A_BOLD


class App(object):
    def __init__(self, stdscr, opts, settings=None):
        self.scr = stdscr
        self.opts = opts
        self.settings = settings if settings is not None else config.load()
        self.theme = Theme()
        self.lock = threading.RLock()

        # live board
        self.board = []
        self.board_min_mag = opts.min_mag
        self.board_period = opts.period
        self.fresh_ids = set()
        self.known_ids = set()
        self.last_update = 0.0
        self.next_refresh = 0.0
        self.refresh_every = max(15.0, opts.interval)
        self.fetching = False
        self.board_error = ""
        self.board_stale = False
        self.first_load = True

        # search
        self.result = None
        self.searching = False
        self.search_min_mag = opts.search_min_mag
        self.search_days = opts.days
        self.strict = bool(opts.strict)
        self.last_query = ""

        # home
        home = self.settings.get("home") or {}
        self.home = ((home["lat"], home["lon"]) if home else None)
        self.home_name = home.get("name") if home else None
        self.home_radius = float(self.settings.get("home_radius_km") or 300.0)

        # view
        self.focus = BOARD
        self.sel = {BOARD: 0, RESULTS: 0}
        self.top = {BOARD: 0, RESULTS: 0}
        self.rows = {BOARD: 0, RESULTS: 0}
        self.status = "Loading live feed..."
        self.status_until = 0.0
        self.bell = opts.bell
        self.show_map = bool(getattr(opts, "map", False))
        self.overlay = None       # help | detail | sequence | activity | marks
        self.overlay_data = None
        self.delete_mode = False
        self.busy = ""
        self.ascii_only = not self._utf8()

    # -- helpers --------------------------------------------------------

    @staticmethod
    def _utf8():
        enc = (os.environ.get("LC_ALL") or os.environ.get("LC_CTYPE")
               or os.environ.get("LANG") or "")
        return "utf-8" in enc.lower() or "utf8" in enc.lower()

    def rule(self, n):
        return ("-" if self.ascii_only else "─") * max(0, n)

    def say(self, text, seconds=5.0):
        self.status = text
        self.status_until = time.time() + seconds

    def _put(self, y, x, text, attr=0):
        h, w = self.scr.getmaxyx()
        if y < 0 or y >= h or x >= w:
            return
        text = text[:max(0, w - x - 1)]
        if not text:
            return
        try:
            self.scr.addstr(y, x, text, attr)
        except curses.error:
            pass

    def _fill(self, y, attr):
        h, w = self.scr.getmaxyx()
        if 0 <= y < h:
            try:
                self.scr.addstr(y, 0, " " * (w - 1), attr)
            except curses.error:
                pass

    def pane_items(self, pane):
        if pane == BOARD:
            return self.board
        return self.result.quakes if self.result else []

    def selected(self):
        items = self.pane_items(self.focus)
        if not items:
            return None
        return items[min(self.sel[self.focus], len(items) - 1)]

    def has_results(self):
        return self.result is not None or self.searching

    # -- background work ------------------------------------------------

    def refresh_board(self):
        with self.lock:
            if self.fetching:
                return
            self.fetching = True
            self.next_refresh = time.time() + self.refresh_every
        threading.Thread(target=self._load_board, daemon=True).start()

    def _load_board(self):
        with self.lock:
            period, min_mag = self.board_period, self.board_min_mag
        try:
            fetched = api.fetch_feed(period, min_mag)
            err = ""
        except api.ApiError as exc:
            fetched, err = None, str(exc)
        with self.lock:
            self.fetching = False
            self.next_refresh = time.time() + self.refresh_every
            if fetched is None:
                self.board_error = err
                self.say("Feed error: %s (retrying)" % err, 8)
                return
            self.board_error = ""
            self.board_stale = fetched.stale
            ids = set(q.id for q in fetched.quakes)
            if self.first_load:
                self.fresh_ids = set()
                self.first_load = False
            else:
                self.fresh_ids = ids - self.known_ids
            self.known_ids = ids
            self.board = fetched.quakes
            self.last_update = time.time()
            self._clamp(BOARD)
            new_big = [q for q in self.board if q.id in self.fresh_ids
                       and q.magnitude >= self.opts.bell_mag]
            if self.fresh_ids:
                self.say("%d new event(s) on the board" % len(self.fresh_ids), 6)
            if new_big and self.bell:
                try:
                    curses.beep()
                except curses.error:
                    pass

    def _background(self, label, work):
        """Run ``work`` off the UI thread with a spinner label."""
        with self.lock:
            if self.busy:
                self.say("still working on %s" % self.busy)
                return
            self.busy = label
        def runner():
            try:
                work()
            finally:
                with self.lock:
                    self.busy = ""
        threading.Thread(target=runner, daemon=True).start()

    def start_search(self, text, min_mag=None, days=None, strict=None):
        text = (text or "").strip()
        if not text:
            return
        with self.lock:
            if min_mag is not None:
                self.search_min_mag = float(min_mag)
            if days is not None:
                self.search_days = float(days)
            if strict is not None:
                self.strict = bool(strict)
            self.last_query = text
            if self.searching:
                return
            self.searching = True
            mag, dys, strct = (self.search_min_mag, self.search_days,
                               self.strict)
            self.say("Searching %s ..." % text, 30)
        threading.Thread(target=self._run_search,
                         args=(text, mag, dys, strct), daemon=True).start()

    def _run_search(self, text, mag, days, strict):
        try:
            res = service.search(text, min_mag=mag, days=days, limit=500,
                                 strict=strict)
            err = ""
        except (api.ApiError, ValueError) as exc:
            res, err = None, str(exc)
        with self.lock:
            self.searching = False
            if res is None:
                self.say("Search failed: %s" % err, 8)
                return
            self._adopt(res, mag, days)

    def _adopt(self, res, mag, days):
        self.result = res
        self.sel[RESULTS] = 0
        self.top[RESULTS] = 0
        self.focus = RESULTS
        if res.quakes:
            extra = ""
            if res.truncated:
                extra = " (showing %d of %s)" % (len(res.quakes),
                                                 "{:,}".format(res.total))
            if res.stale:
                extra += " [cached: network unavailable]"
            self.say("%s: %s events, M%.1f+ over %g day(s)%s"
                     % (res.label, "{:,}".format(res.total), mag, days, extra),
                     8)
        else:
            tip = ""
            if not regions.resolve(res.query):
                names = regions.suggest(res.query, 4)
                if names:
                    tip = " Try: %s" % ", ".join(
                        regions.display_name(n) for n in names)
            self.say("No events for %s at M%.1f+ in %g day(s).%s"
                     % (res.label, mag, days, tip), 10)

    def search_near_home(self):
        if not self.home:
            self.say("no home set - press N to set one", 8)
            return
        lat, lon = self.home
        name = self.home_name or "home"
        radius, mag, days = self.home_radius, self.search_min_mag, \
            self.search_days
        def work():
            try:
                res = service.near(lat, lon, radius_km=radius, min_mag=mag,
                                   days=days, limit=500, label=name)
            except api.ApiError as exc:
                with self.lock:
                    self.say("near-me search failed: %s" % exc, 8)
                return
            with self.lock:
                self.last_query = ""
                self._adopt(res, mag, days)
        self.say("Searching within %s of %s ..." % (geo.format_km(radius),
                                                    name), 30)
        self._background("near-me search", work)

    def show_sequence(self):
        q = self.selected()
        if q is None:
            self.say("select an event first")
            return
        if q.lat is None or q.lon is None:
            self.say("that event has no coordinates")
            return
        self.say("Looking for aftershocks around %s ..." % q.place[:40], 30)
        def work():
            try:
                seq = service.sequence(q)
            except (api.ApiError, ValueError) as exc:
                with self.lock:
                    self.say("sequence lookup failed: %s" % exc, 8)
                return
            with self.lock:
                self.overlay, self.overlay_data = "sequence", seq
                self.say("%d aftershocks within %s"
                         % (len(seq.aftershocks),
                            geo.format_km(seq.radius_km)), 8)
        self._background("aftershock lookup", work)

    def show_activity(self):
        query = None
        center = radius = None
        label = None
        if self.result is not None and self.result.center:
            center, radius = self.result.center, self.result.radius_km
            label = self.result.label
        elif self.result is not None and regions.resolve(self.result.query):
            query = self.result.query
        elif self.last_query and regions.resolve(self.last_query):
            query = self.last_query
        mag = self.search_min_mag
        self.say("Comparing recent activity with the last 12 months ...", 30)
        def work():
            try:
                act = service.activity(query=query, center=center,
                                       radius_km=radius, min_mag=mag,
                                       label=label)
            except (api.ApiError, ValueError) as exc:
                with self.lock:
                    self.say("activity lookup failed: %s" % exc, 8)
                return
            with self.lock:
                self.overlay, self.overlay_data = "activity", act
                self.say(act.verdict(), 10)
        self._background("activity lookup", work)

    # -- bookmarks ------------------------------------------------------

    def bookmarks(self):
        return self.settings.get("bookmarks", [])

    def open_bookmark(self, slot):
        marks = self.bookmarks()
        if not (1 <= slot <= len(marks)):
            self.say("no bookmark in slot %d - press B to save one" % slot)
            return
        mark = marks[slot - 1]
        self.start_search(mark["query"], mark.get("min_mag"),
                          mark.get("days"), mark.get("strict", False))

    def save_bookmark(self):
        if not self.last_query:
            self.say("run a search first, then press B to bookmark it")
            return
        config.add_bookmark(self.settings, self.last_query,
                            self.search_min_mag, self.search_days, self.strict)
        if config.save(self.settings):
            self.say("bookmarked %s in slot 1 (press 1 to return to it)"
                     % self.last_query, 8)
        else:
            self.say("could not write %s" % config.config_path(), 8)

    def delete_bookmark(self, slot):
        mark = config.remove_bookmark(self.settings, slot)
        if mark is None:
            self.say("no bookmark in slot %d" % slot)
            return
        config.save(self.settings)
        self.say("removed bookmark %s" % mark["query"], 6)

    def set_home(self):
        current = ""
        if self.home:
            current = "%.4f,%.4f" % self.home
        raw = self.prompt("Home as LAT,LON (blank to clear):", current)
        if raw is None:
            return
        if raw == "":
            self.home = None
            self.settings["home"] = None
            config.save(self.settings)
            self.say("home cleared")
            return
        try:
            lat, lon = geo.parse_latlon(raw)
        except ValueError as exc:
            self.say(str(exc), 8)
            return
        name = self.prompt("Name for it:", self.home_name or "home") or "home"
        self.home, self.home_name = (lat, lon), name
        config.set_home(self.settings, lat, lon, name)
        if config.save(self.settings):
            self.say("home set to %s (%.4f, %.4f) - press n to search near it"
                     % (name, lat, lon), 8)

    # -- layout ---------------------------------------------------------

    def _geometry(self):
        h, w = self.scr.getmaxyx()
        body = h - 2
        lower = self.has_results() or self.show_map
        if lower:
            board_rows = max(3, min(self.opts.board_rows, (body - 6) // 2))
        else:
            board_rows = max(3, body - 4)
        board_rows = min(board_rows, max(1, body - 4))
        return h, w, board_rows

    def _clamp(self, pane):
        items = self.pane_items(pane)
        n = len(items)
        self.sel[pane] = 0 if n == 0 else max(0, min(self.sel[pane], n - 1))
        rows = max(1, self.rows.get(pane, 1))
        top = min(self.top[pane], max(0, n - rows))
        top = max(0, min(top, self.sel[pane]))
        if self.sel[pane] >= top + rows:
            top = self.sel[pane] - rows + 1
        self.top[pane] = max(0, top)

    # -- drawing --------------------------------------------------------

    def draw(self):
        self.scr.erase()
        h, w, board_rows = self._geometry()
        self._draw_title(w)
        y = self._draw_board(1, w, board_rows)
        height = h - 1 - y
        if self.show_map:
            self._draw_map(y, w, height)
        elif self.has_results():
            self._draw_results(y, w, height)
        self._draw_status(h, w)
        self.scr.noutrefresh()
        if self.overlay == "help":
            self._draw_help()
        elif self.overlay == "detail":
            self._draw_detail()
        elif self.overlay == "sequence":
            self._draw_sequence()
        elif self.overlay == "activity":
            self._draw_activity()
        elif self.overlay == "marks":
            self._draw_marks()
        curses.doupdate()

    def _draw_title(self, w):
        self._fill(0, self.theme.title)
        left = " QUAKEBOARD  live seismic monitor  (USGS) "
        right = time.strftime("%Y-%m-%d %H:%M:%S ")
        self._put(0, 0, left, self.theme.title)
        if self.busy and w > len(left) + len(right) + 24:
            self._put(0, len(left) + 1, "working: %s" % self.busy,
                      self.theme.title)
        if w > len(left) + len(right) + 2:
            self._put(0, w - len(right) - 1, right, self.theme.title)

    def _board_caption(self, w):
        label = api.FEEDS[self.board_period][1]
        cap = " LIVE BOARD  M%.1f+  %s " % (self.board_min_mag, label)
        if self.fetching:
            state = "updating..."
        elif self.board_error:
            state = "OFFLINE - retrying"
        elif self.last_update:
            left = max(0, int(self.next_refresh - time.time()))
            state = "updated %s / next %ds" % (
                humanize_age(time.time() - self.last_update), left)
            if self.board_stale:
                state = "cached copy / " + state
        else:
            state = "connecting..."
        state = " %s " % state
        pad = max(1, w - len(cap) - len(state) - 2)
        return cap + self.rule(pad) + state

    def _draw_board(self, y, w, rows):
        attr = self.theme.chrome
        if self.focus == BOARD:
            attr = attr | curses.A_REVERSE
        self._put(y, 0, self._board_caption(w), attr)
        y += 1
        self._put(y, 0, self._header(w, "AGE"), self.theme.chrome)
        y += 1
        self.rows[BOARD] = rows
        self._clamp(BOARD)
        if not self.board:
            msg = ("waiting for the first feed update..." if self.first_load
                   else "no events at M%.1f+ in the %s"
                        % (self.board_min_mag, api.FEEDS[self.board_period][1]))
            self._put(y, 2, msg, curses.A_DIM)
        for i in range(rows):
            idx = self.top[BOARD] + i
            if idx >= len(self.board):
                break
            self._draw_row(y + i, w, self.board[idx], BOARD, idx, "age")
        y += rows
        self._put(y, 0, self.rule(w - 1), self.theme.chrome | curses.A_DIM)
        return y + 1

    def _results_caption(self, w):
        if self.searching:
            return " SEARCH  %s ... %s working " % (
                self.last_query, self.rule(max(1, w - len(self.last_query) - 22)))
        res = self.result
        cap = " SEARCH  %s  M%.1f+  %gd " % (res.label, self.search_min_mag,
                                             self.search_days)
        if res.truncated:
            shown = "showing %d of %s" % (len(res.quakes),
                                          "{:,}".format(res.total))
        else:
            shown = "%d hits" % len(res.quakes)
        bits = [shown, res.note]
        if self.strict:
            bits.append("strict")
        if res.stale:
            bits.append("cached")
        state = " %s " % " / ".join(bits)
        pad = max(1, w - len(cap) - len(state) - 2)
        return cap + self.rule(pad) + state

    def _draw_results(self, y, w, height):
        if height < 3:
            return
        attr = self.theme.chrome
        if self.focus == RESULTS:
            attr = attr | curses.A_REVERSE
        self._put(y, 0, self._results_caption(w)[:w - 1], attr)
        self._put(y + 1, 0, self._header(w, "WHEN"), self.theme.chrome)
        rows = height - 2
        self.rows[RESULTS] = rows
        self._clamp(RESULTS)
        items = self.pane_items(RESULTS)
        if not items and not self.searching:
            self._put(y + 2, 2, "no matching events - press / to search again",
                      curses.A_DIM)
        for i in range(rows):
            idx = self.top[RESULTS] + i
            if idx >= len(items):
                break
            self._draw_row(y + 2 + i, w, items[idx], RESULTS, idx, "when")

    def _map_bounds(self):
        res = self.result
        if res is None:
            return None
        if res.center and res.radius_km:
            lat, lon = res.center
            dlat = res.radius_km / 111.0
            dlon = dlat / max(0.2, abs(math.cos(math.radians(lat))))
            return (lat - dlat, lat + dlat, lon - dlon, lon + dlon)
        hit = regions.resolve(res.query)
        if hit and len(hit[1]) == 1:
            return hit[1][0]
        return None

    def _draw_map(self, y, w, height):
        if height < 4:
            return
        quakes = self.pane_items(RESULTS) or self.board
        bounds = self._map_bounds()
        label = "world"
        if bounds and self.result is not None:
            label = self.result.label
        cap = " MAP  %s  %s " % (label, "%d events" % len(quakes))
        pad = max(1, w - len(cap) - 2)
        self._put(y, 0, cap + self.rule(pad), self.theme.chrome)
        rows, cols = height - 1, max(20, w - 2)
        try:
            shot = worldmap.render(quakes, cols, rows, bounds=bounds,
                                   home=self.home, selected=self.selected(),
                                   ascii_only=self.ascii_only)
        except Exception:                      # never let the map kill the UI
            self._put(y + 1, 2, "map unavailable at this size", curses.A_DIM)
            return
        for i, line in enumerate(shot.rows):
            self._put(y + 1 + i, 1, line, self.theme.land)
        for row, col, char, tier, q in shot.markers:
            attr = (self.theme.fresh if q is None
                    else self.theme.mag(tier) | curses.A_BOLD)
            if q is not None and self.selected() is not None \
                    and q.id == self.selected().id:
                attr = attr | curses.A_REVERSE
            self._put(y + 1 + row, 1 + col, char, attr)
        if shot.offscreen:
            self._put(y + height - 1, w - 22, "%d off view" % shot.offscreen,
                      curses.A_DIM)

    def _header(self, w, first):
        place_w = max(10, w - (2 + W_AGE + W_MAG + W_DEPTH + W_FLAGS + 6))
        return "  %-*s %*s %*s  %-*s %-*s" % (
            W_AGE, first, W_MAG, "MAG", W_DEPTH, "DEPTH",
            place_w, "LOCATION", W_FLAGS, "NOTES")

    def _draw_row(self, y, w, q, pane, idx, time_col="age"):
        place_w = max(10, w - (2 + W_AGE + W_MAG + W_DEPTH + W_FLAGS + 6))
        when = (humanize_age(q.age_seconds()) if time_col == "age"
                else time.strftime("%m-%d %H:%M", time.localtime(q.epoch)))
        is_new = pane == BOARD and q.id in self.fresh_ids
        line = "%s %-*s %*s %*s  %-*.*s %-*.*s" % (
            "*" if is_new else " ", W_AGE, when[:W_AGE], W_MAG, q.mag_text(),
            W_DEPTH, q.depth_text(), place_w, place_w, q.place,
            W_FLAGS, W_FLAGS, q.flags())
        attr = self.theme.mag(q.tier())
        if is_new:
            attr = attr | curses.A_BOLD
        if idx == self.sel[pane]:
            attr = attr | curses.A_REVERSE
            self._fill(y, attr)
        self._put(y, 0, line, attr)

    def _draw_status(self, h, w):
        self._fill(h - 1, self.theme.status)
        if time.time() > self.status_until:
            self.status = ("/ search   n near me   a aftershocks   g map   "
                           "x context   1-9 saved   ? help   q quit")
        self._put(h - 1, 1, self.status[:max(0, w - 2)], self.theme.status)

    # -- overlays -------------------------------------------------------

    @staticmethod
    def _wput(win, y, x, text, attr=0):
        h, w = win.getmaxyx()
        if y < 0 or y >= h or x >= w - 1:
            return
        try:
            win.addnstr(y, x, text, max(0, w - x - 1), attr)
        except curses.error:
            pass

    def _window(self, height, width):
        h, w = self.scr.getmaxyx()
        height, width = min(height, h - 2), min(width, w - 2)
        win = curses.newwin(max(3, height), max(20, width),
                            max(0, (h - height) // 2), max(0, (w - width) // 2))
        win.bkgd(" ", self.theme.pair(1))
        win.erase()
        win.box()
        return win

    def _panel(self, title, lines, width=76, footer="any key to close"):
        win = self._window(len(lines) + 4, width)
        h = win.getmaxyx()[0]
        self._wput(win, 0, 2, " %s " % title, self.theme.chrome)
        for i, item in enumerate(lines):
            if i + 2 >= h - 2:
                break
            if isinstance(item, tuple):
                text, attr = item
            else:
                text, attr = item, 0
            self._wput(win, i + 2, 3, text, attr)
        self._wput(win, h - 2, 3, footer, curses.A_DIM)
        win.noutrefresh()

    HELP = [
        ("/", "search by country or region (e.g. japan, chile, aegean)"),
        ("n / N", "search near your home location / set that location"),
        ("a", "aftershocks and foreshocks around the selected event"),
        ("x", "how the current region compares with its last 12 months"),
        ("g", "toggle the world map"),
        ("1-9 / 0", "open a saved search / manage saved searches"),
        ("B", "save the current search"),
        ("r", "refresh the live board now (re-runs the last search too)"),
        ("m / M", "minimum magnitude for the board / for searches"),
        ("t", "cycle the board window: hour, 24h, 7 days, 30 days"),
        ("d", "days of history to search"),
        ("i", "auto-refresh interval for the board"),
        ("s", "toggle strict place-name filtering of search results"),
        ("c", "clear the search pane"),
        ("TAB", "move focus between the board and the results"),
        ("arrows / j k", "move the selection; PgUp PgDn Home End also work"),
        ("ENTER", "full detail for the selected event"),
        ("o", "open the selected event's USGS page in a browser"),
        ("e", "export the focused pane to a CSV file"),
        ("b", "toggle the audible alert for new big events"),
        ("? h", "this help"),
        ("q", "quit"),
    ]

    def _draw_help(self):
        lines = ["%-13s %s" % (key, text) for key, text in self.HELP]
        self._panel("Keys", lines, 76,
                    "Data: earthquake.usgs.gov  -  any key to close")

    def _draw_detail(self):
        q = self.selected()
        if q is None:
            self.overlay = None
            return
        rows = [
            ("Magnitude", "M %s  (%s)" % (q.mag_text().strip(),
                                          q.mag_type or "unknown type")),
            ("Location", q.place),
            ("Coordinates", "%.4f, %.4f" % (q.lat, q.lon)
             if q.lat is not None and q.lon is not None else "unknown"),
            ("Depth", "%.1f km" % q.depth_km if q.depth_km is not None
             else "unknown"),
        ]
        if self.home and q.lat is not None:
            km = geo.haversine(self.home[0], self.home[1], q.lat, q.lon)
            rows.append(("From %s" % (self.home_name or "home"),
                         "%s %s" % (geo.format_km(km),
                                    geo.direction_from(self.home[0],
                                                       self.home[1],
                                                       q.lat, q.lon))))
        rows += [
            ("Local time", "%s (%s)" % (q.local_time(),
                                        humanize_age(q.age_seconds()))),
            ("UTC time", q.utc_time()),
            ("Tsunami flag", "YES - check official advisories" if q.tsunami
             else "no"),
            ("PAGER alert", (q.alert or "none").upper()),
            ("Felt reports", str(q.felt) if q.felt else "none"),
            ("Intensity", "CDI %s / MMI %s"
             % (q.cdi if q.cdi is not None else "-",
                q.mmi if q.mmi is not None else "-")),
            ("Significance", str(q.sig) if q.sig is not None else "-"),
            ("Review status", "%s (%s)" % (q.status or "unknown", q.net)),
            ("Event type", q.etype),
            ("Event id", q.id),
        ]
        lines = [(q.title or q.place, self.theme.mag(q.tier())), ""]
        for label, value in rows:
            chunks = textwrap.wrap(str(value), 54) or [""]
            lines.append("%-14s %s" % (label, chunks[0]))
            for extra in chunks[1:]:
                lines.append("%-14s %s" % ("", extra))
        lines += ["", (q.url, curses.A_DIM)]
        self._panel("Event detail", lines, 78,
                    "a aftershocks  -  o open in browser  -  any key to close")

    def _draw_sequence(self):
        seq = self.overlay_data
        if seq is None:
            self.overlay = None
            return
        main = seq.main
        big, fore = seq.largest, seq.largest_foreshock
        counts = seq.counts_by_day(min(14, max(3, int(seq.elapsed_days) + 1)))
        lines = [
            (main.title or main.place, self.theme.mag(main.tier())),
            "",
            "%-16s %s around the epicentre" % ("Searched",
                                                 geo.format_km(seq.radius_km)),
            "%-16s %s to now, M%.1f and above"
            % ("Window", main.local_time(), seq.min_mag),
            "%-16s %d" % ("Foreshocks", len(seq.foreshocks)),
            "%-16s %s" % ("  largest",
                          ("M%s, %s earlier" % (fore.mag_text().strip(),
                           humanize_span(main.epoch - fore.epoch)))
                          if fore else "none"),
            "%-16s %d" % ("Aftershocks", len(seq.aftershocks)),
            "%-16s %s" % ("  largest",
                          ("M%s, %s later" % (big.mag_text().strip(),
                           humanize_span(big.epoch - main.epoch)))
                          if big else "none"),
        ]
        gap = seq.bath_gap()
        if gap is not None:
            lines.append("%-16s %.1f  (Bath's law expects about 1.2)"
                         % ("  size gap", gap))
        lines += [
            "%-16s %d in the first 24h, %d in the last 24h"
            % ("Rate", seq.rate_first_day, seq.rate_last_day),
            "%-16s %s  (per day since the mainshock)"
            % ("Shape", spark(counts, self.ascii_only)),
            "%-16s %s" % ("  counts", " ".join(str(c) for c in counts[:12])),
            "",
        ]
        for line in textwrap.wrap(seq.verdict(), 66):
            lines.append(line)
        if seq.aftershocks:
            lines += ["", ("Largest few:", curses.A_BOLD)]
            for q in sorted(seq.aftershocks, key=lambda q: q.magnitude,
                            reverse=True)[:5]:
                lines.append(("  M%-5s %-38s %s"
                              % (q.mag_text().strip(), q.place[:38],
                                 humanize_age(q.age_seconds())),
                              self.theme.mag(q.tier())))
        self._panel("Sequence", lines, 74)

    def _draw_activity(self):
        act = self.overlay_data
        if act is None:
            self.overlay = None
            return
        lines = [
            ("%s - events at M%.1f and above" % (act.label, act.min_mag),
             curses.A_BOLD),
            "",
            "%-22s %s" % ("Last %g days" % act.recent_days,
                          "{:,}".format(act.recent) if act.recent is not None
                          else "unknown"),
            "%-22s %s" % ("Last %g days" % act.baseline_days,
                          "{:,}".format(act.baseline)
                          if act.baseline is not None else "unknown"),
        ]
        if act.expected:
            lines.append("%-22s %.0f" % ("Expected in %g days"
                                         % act.recent_days, act.expected))
        if act.ratio:
            lines.append("%-22s %.2fx the 12-month rate" % ("Ratio",
                                                            act.ratio))
        lines += ["", ("By magnitude, last %g days:" % act.recent_days,
                       curses.A_BOLD)]
        widest = max([n for _, _, n in act.bands if n] or [1])
        for lo, hi, n in act.bands:
            name = "M%.1f+" % lo if hi is None else "M%.1f - %.1f" % (lo,
                                                                      hi - 0.1)
            bar = "" if not n else ("#" if self.ascii_only
                                    else "█") * max(1, int(28.0 * n
                                                                / widest))
            lines.append("  %-14s %6s %s"
                         % (name, "-" if n is None else "{:,}".format(n), bar))
        lines.append("")
        for line in textwrap.wrap(act.verdict(), 66):
            lines.append(line)
        self._panel("Activity in context", lines, 74)

    def _draw_marks(self):
        marks = self.bookmarks()
        lines = []
        if not marks:
            lines.append("No saved searches yet.")
            lines.append("")
            lines.append("Run a search, then press B to save it here.")
        else:
            for i, mark in enumerate(marks, 1):
                bits = []
                if mark.get("min_mag") is not None:
                    bits.append("M%.1f+" % mark["min_mag"])
                if mark.get("days") is not None:
                    bits.append("%gd" % mark["days"])
                if mark.get("strict"):
                    bits.append("strict")
                lines.append("  %d  %-32s %s" % (i, mark["query"],
                                                 "  ".join(bits)))
        lines += ["", ("Stored in %s" % config.config_path(), curses.A_DIM)]
        footer = "1-9 open  -  d then a digit deletes  -  any key to close"
        if self.delete_mode:
            footer = "DELETE: press a digit to remove that saved search"
        self._panel("Saved searches", lines, 74, footer)

    # -- prompts --------------------------------------------------------

    def prompt(self, label, initial=""):
        h, w = self.scr.getmaxyx()
        buf = list(initial)
        try:
            curses.curs_set(1)
        except curses.error:
            pass
        try:
            while True:
                self._fill(h - 1, self.theme.status)
                text = "%s %s" % (label, "".join(buf))
                self._put(h - 1, 1, text[:max(0, w - 3)], self.theme.status)
                try:
                    self.scr.move(h - 1, min(w - 2, 1 + len(text)))
                except curses.error:
                    pass
                self.scr.refresh()
                ch = self.scr.getch()
                if ch == 27:
                    return None
                if ch in (10, 13, curses.KEY_ENTER):
                    return "".join(buf).strip()
                if ch in (curses.KEY_BACKSPACE, 127, 8):
                    if buf:
                        buf.pop()
                    continue
                if ch == curses.KEY_RESIZE:
                    h, w = self.scr.getmaxyx()
                    with self.lock:
                        self.draw()
                    continue
                if ch == curses.KEY_DC:
                    buf = []
                    continue
                if 32 <= ch < 127 and len(buf) < 60:
                    buf.append(chr(ch))
        finally:
            try:
                curses.curs_set(0)
            except curses.error:
                pass

    def prompt_float(self, label, current, low, high):
        raw = self.prompt("%s [%g]:" % (label, current))
        if raw is None:
            return None
        if raw == "":
            return current
        try:
            value = float(raw)
        except ValueError:
            self.say("'%s' is not a number" % raw)
            return None
        if not (low <= value <= high):
            self.say("value must be between %g and %g" % (low, high))
            return None
        return value

    # -- actions --------------------------------------------------------

    def export(self):
        items = self.pane_items(self.focus)
        if not items:
            self.say("nothing to export in this pane")
            return
        who = ("board" if self.focus == BOARD
               else regions.normalize(self.result.label).replace(" ", "_"))
        name = "quakes-%s-%s.csv" % (who or "search",
                                     time.strftime("%Y%m%d-%H%M%S"))
        try:
            with open(name, "w", newline="") as fh:
                out = csv.writer(fh)
                head = ["time_utc", "magnitude", "mag_type", "depth_km",
                        "latitude", "longitude", "place", "tsunami", "alert",
                        "status", "id", "url"]
                if self.home:
                    head.insert(7, "km_from_home")
                out.writerow(head)
                for q in items:
                    row = [q.utc_time(), q.mag, q.mag_type, q.depth_km, q.lat,
                           q.lon, q.place, int(bool(q.tsunami)), q.alert or "",
                           q.status, q.id, q.url]
                    if self.home:
                        km = geo.haversine(self.home[0], self.home[1],
                                           q.lat, q.lon)
                        row.insert(7, "" if km is None else round(km, 1))
                    out.writerow(row)
        except OSError as exc:
            self.say("export failed: %s" % exc, 8)
            return
        self.say("wrote %d events to %s" % (len(items), name), 8)

    def open_browser(self):
        q = self.selected()
        if q is None or not q.url:
            self.say("no event page for this row")
            return
        try:
            webbrowser.open(q.url)
            self.say("opened %s" % q.url, 6)
        except Exception as exc:
            self.say("could not open browser: %s" % exc, 8)

    def move(self, delta):
        items = self.pane_items(self.focus)
        if not items:
            return
        self.sel[self.focus] = max(0, min(len(items) - 1,
                                          self.sel[self.focus] + delta))
        self._clamp(self.focus)

    def _handle_overlay_key(self, ch):
        if self.overlay == "marks":
            if self.delete_mode and ord("1") <= ch <= ord("9"):
                self.delete_bookmark(ch - ord("0"))
                self.delete_mode = False
                return True
            if ch in (ord("d"), ord("D")):
                self.delete_mode = not self.delete_mode
                return True
            if ord("1") <= ch <= ord("9"):
                self.overlay = None
                self.open_bookmark(ch - ord("0"))
                return True
        if self.overlay == "detail":
            if ch in (ord("o"), ord("O")):
                self.open_browser()
                return True
            if ch in (ord("a"), ord("A")):
                self.overlay = None
                self.show_sequence()
                return True
        self.overlay = None
        self.delete_mode = False
        return True

    def handle(self, ch):
        if ch == curses.KEY_RESIZE:
            return True
        if self.overlay:
            return self._handle_overlay_key(ch)
        if ch in (ord("q"), ord("Q")):
            return False
        if ch in (9, curses.KEY_BTAB):
            self.focus = RESULTS if (self.focus == BOARD
                                     and self.result is not None) else BOARD
        elif ch in (curses.KEY_DOWN, ord("j")):
            self.move(1)
        elif ch in (curses.KEY_UP, ord("k")):
            self.move(-1)
        elif ch == curses.KEY_NPAGE:
            self.move(max(1, self.rows.get(self.focus, 5)))
        elif ch == curses.KEY_PPAGE:
            self.move(-max(1, self.rows.get(self.focus, 5)))
        elif ch == curses.KEY_HOME:
            self.move(-10 ** 6)
        elif ch == curses.KEY_END:
            self.move(10 ** 6)
        elif ch in (10, 13, curses.KEY_ENTER):
            if self.selected() is not None:
                self.overlay = "detail"
        elif ch in (ord("?"), ord("h"), ord("H")):
            self.overlay = "help"
        elif ch == ord("/"):
            text = self.prompt("Country or region:", "")
            if text:
                self.start_search(text)
        elif ch == ord("n"):
            self.search_near_home()
        elif ch == ord("N"):
            self.set_home()
        elif ch in (ord("a"), ord("A")):
            self.show_sequence()
        elif ch in (ord("x"), ord("X")):
            self.show_activity()
        elif ch in (ord("g"), ord("G")):
            self.show_map = not self.show_map
            self.say("map %s" % ("shown" if self.show_map else "hidden"))
        elif ch == ord("B"):
            self.save_bookmark()
        elif ch == ord("0"):
            self.overlay = "marks"
        elif ord("1") <= ch <= ord("9"):
            self.open_bookmark(ch - ord("0"))
        elif ch in (ord("r"), ord("R")):
            self.refresh_board()
            if self.last_query:
                self.start_search(self.last_query)
            self.say("refreshing...")
        elif ch == ord("m"):
            value = self.prompt_float("Board minimum magnitude",
                                      self.board_min_mag, -1.0, 10.0)
            if value is not None:
                self.board_min_mag = value
                self.settings["min_mag"] = value
                self.first_load = True
                self.refresh_board()
        elif ch == ord("M"):
            value = self.prompt_float("Search minimum magnitude",
                                      self.search_min_mag, -1.0, 10.0)
            if value is not None:
                self.search_min_mag = value
                self.settings["search_min_mag"] = value
                if self.last_query:
                    self.start_search(self.last_query)
        elif ch in (ord("t"), ord("T")):
            order = api.FEED_ORDER
            self.board_period = order[(order.index(self.board_period) + 1)
                                      % len(order)]
            self.settings["period"] = self.board_period
            self.first_load = True
            self.refresh_board()
            self.say("board window: %s" % api.FEEDS[self.board_period][1])
        elif ch in (ord("d"), ord("D")):
            value = self.prompt_float("Search history in days",
                                      self.search_days, 0.05, 365.0)
            if value is not None:
                self.search_days = value
                self.settings["days"] = value
                if self.last_query:
                    self.start_search(self.last_query)
        elif ch in (ord("i"), ord("I")):
            value = self.prompt_float("Auto-refresh seconds",
                                      self.refresh_every, 15.0, 3600.0)
            if value is not None:
                self.refresh_every = value
                self.settings["interval"] = value
                self.next_refresh = self.last_update + value
                self.say("refreshing every %gs" % value)
        elif ch in (ord("s"), ord("S")):
            self.strict = not self.strict
            self.say("strict name filter %s" % ("on" if self.strict else "off"))
            if self.last_query:
                self.start_search(self.last_query)
        elif ch in (ord("c"), ord("C")):
            self.result = None
            self.focus = BOARD
            self.say("search cleared")
        elif ch in (ord("o"), ord("O")):
            self.open_browser()
        elif ch in (ord("e"), ord("E")):
            self.export()
        elif ch in (ord("b"),):
            self.bell = not self.bell
            self.settings["bell"] = self.bell
            self.say("alert sound %s" % ("on" if self.bell else "off"))
        return True

    # -- main loop ------------------------------------------------------

    def run(self):
        try:
            curses.curs_set(0)
        except curses.error:
            pass
        self.scr.timeout(250)
        self.refresh_board()
        if self.opts.query:
            self.start_search(self.opts.query)
        elif getattr(self.opts, "near", False):
            self.search_near_home()
        while True:
            with self.lock:
                self.draw()
            ch = self.scr.getch()
            if ch != -1:
                with self.lock:
                    if not self.handle(ch):
                        break
            if not self.fetching and time.time() >= self.next_refresh:
                self.refresh_board()
        config.save(self.settings)


def launch(opts, settings=None):
    def main(stdscr):
        App(stdscr, opts, settings).run()
    curses.wrapper(main)
