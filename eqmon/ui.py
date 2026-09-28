"""Curses interface: a live magnitude board on top, search results below."""

import csv
import curses
import os
import textwrap
import threading
import time
import webbrowser

from . import api, regions, service
from .model import humanize_age

BOARD = "board"
RESULTS = "results"

# Column widths shared by both panes.
W_AGE = 11
W_MAG = 5
W_DEPTH = 9
W_FLAGS = 16


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
            (1, curses.COLOR_WHITE, bg),      # M < 4
            (2, curses.COLOR_YELLOW, bg),     # M 4-4.9
            (3, curses.COLOR_MAGENTA, bg),    # M 5-5.9
            (4, curses.COLOR_RED, bg),        # M 6-6.9
            (5, curses.COLOR_WHITE, curses.COLOR_RED),   # M 7+
            (6, curses.COLOR_CYAN, bg),       # chrome
            (7, curses.COLOR_GREEN, bg),      # fresh / ok
            (8, curses.COLOR_BLACK, curses.COLOR_CYAN),  # title bar
            (9, curses.COLOR_BLACK, curses.COLOR_WHITE), # status bar
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
    def title(self):
        return self.pair(8) | curses.A_BOLD if self.color else curses.A_REVERSE

    @property
    def status(self):
        return self.pair(9) if self.color else curses.A_REVERSE

    @property
    def fresh(self):
        return self.pair(7) | curses.A_BOLD


class App(object):
    def __init__(self, stdscr, opts):
        self.scr = stdscr
        self.opts = opts
        self.theme = Theme()
        self.lock = threading.RLock()
        self.stop = threading.Event()

        # live board state
        self.board = []
        self.board_min_mag = opts.min_mag
        self.board_period = opts.period
        self.fresh_ids = set()
        self.known_ids = set()
        self.last_update = 0.0
        self.next_refresh = 0.0
        self.refresh_every = max(15, opts.interval)
        self.fetching = False
        self.board_error = ""
        self.first_load = True

        # search state
        self.result = None
        self.searching = False
        self.search_error = ""
        self.search_min_mag = opts.search_min_mag
        self.search_days = opts.days
        self.strict = False
        self.last_query = ""

        # view state
        self.focus = BOARD
        self.sel = {BOARD: 0, RESULTS: 0}
        self.top = {BOARD: 0, RESULTS: 0}
        self.rows = {BOARD: 0, RESULTS: 0}
        self.status = "Loading live feed..."
        self.status_until = 0.0
        self.bell = opts.bell
        self.overlay = None     # None | "help" | "detail"
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

    # -- background work ------------------------------------------------

    def refresh_board(self):
        """Kick off a board refresh unless one is already in flight."""
        with self.lock:
            if self.fetching:
                return
            self.fetching = True          # claimed here, so no double fetch
            self.next_refresh = time.time() + self.refresh_every
        threading.Thread(target=self._load_board, daemon=True).start()

    def _load_board(self):
        with self.lock:
            period, min_mag = self.board_period, self.board_min_mag
        try:
            quakes = api.fetch_feed(period, min_mag)
            err = ""
        except api.ApiError as exc:
            quakes, err = None, str(exc)
        with self.lock:
            self.fetching = False
            self.next_refresh = time.time() + self.refresh_every
            if quakes is None:
                self.board_error = err
                self.say("Feed error: %s (retrying)" % err, 8)
                return
            self.board_error = ""
            ids = set(q.id for q in quakes)
            if self.first_load:
                self.fresh_ids = set()
                self.first_load = False
            else:
                self.fresh_ids = ids - self.known_ids
            self.known_ids = ids
            self.board = quakes
            self.last_update = time.time()
            self._clamp(BOARD)
            new_big = [q for q in quakes
                       if q.id in self.fresh_ids and q.magnitude >= self.opts.bell_mag]
            if self.fresh_ids:
                self.say("%d new event(s) on the board" % len(self.fresh_ids), 6)
            if new_big and self.bell:
                try:
                    curses.beep()
                except curses.error:
                    pass

    def start_search(self, text):
        text = (text or "").strip()
        if not text:
            return
        self.last_query = text
        threading.Thread(target=self._run_search, args=(text,), daemon=True).start()

    def _run_search(self, text):
        with self.lock:
            if self.searching:
                return
            self.searching = True
            self.search_error = ""
            self.say("Searching %s ..." % text, 30)
            mag, days, strict = self.search_min_mag, self.search_days, self.strict
        try:
            res = service.search(text, min_mag=mag, days=days, limit=500,
                                 strict=strict)
            err = ""
        except api.ApiError as exc:
            res, err = None, str(exc)
        except ValueError as exc:
            res, err = None, str(exc)
        with self.lock:
            self.searching = False
            if res is None:
                self.search_error = err
                self.say("Search failed: %s" % err, 8)
                return
            self.result = res
            self.sel[RESULTS] = 0
            self.top[RESULTS] = 0
            self.focus = RESULTS
            if res.quakes:
                self.say("%s: %d events, M%.1f+ over %d day(s)"
                         % (res.label, len(res.quakes), mag, days), 8)
            else:
                tip = ""
                if not regions.resolve(text):
                    names = regions.suggest(text, 4)
                    if names:
                        tip = " Try: %s" % ", ".join(
                            regions.display_name(n) for n in names)
                self.say("No events for %s at M%.1f+ in %d day(s).%s"
                         % (res.label, mag, days, tip), 10)

    # -- layout ---------------------------------------------------------

    def _geometry(self):
        h, w = self.scr.getmaxyx()
        body = h - 2                      # title bar + status bar
        has_results = self.result is not None or self.searching
        wanted = self.opts.board_rows
        if has_results:
            board_rows = max(3, min(wanted, (body - 6) // 2))
        else:
            board_rows = max(3, body - 4)
        board_rows = min(board_rows, max(1, body - 4))
        return h, w, board_rows, has_results

    def _clamp(self, pane):
        items = self.pane_items(pane)
        n = len(items)
        self.sel[pane] = 0 if n == 0 else max(0, min(self.sel[pane], n - 1))
        rows = max(1, self.rows.get(pane, 1))
        top = self.top[pane]
        top = min(top, max(0, n - rows))
        top = max(0, min(top, self.sel[pane]))
        if self.sel[pane] >= top + rows:
            top = self.sel[pane] - rows + 1
        self.top[pane] = max(0, top)

    # -- drawing --------------------------------------------------------

    def draw(self):
        self.scr.erase()
        h, w, board_rows, has_results = self._geometry()
        self._draw_title(w)
        y = 1
        y = self._draw_board(y, w, board_rows)
        if has_results:
            self._draw_results(y, w, h - 1 - y)
        self._draw_status(h, w)
        # stdscr goes to the virtual screen first so an overlay lands on top
        self.scr.noutrefresh()
        if self.overlay == "help":
            self._draw_help()
        elif self.overlay == "detail":
            self._draw_detail()
        curses.doupdate()

    def _draw_title(self, w):
        self._fill(0, self.theme.title)
        left = " QUAKEBOARD  live seismic monitor  (USGS) "
        right = time.strftime("%Y-%m-%d %H:%M:%S ")
        self._put(0, 0, left, self.theme.title)
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
        items = self.board
        if not items:
            msg = ("waiting for the first feed update..." if self.first_load
                   else "no events at M%.1f+ in the %s"
                        % (self.board_min_mag, api.FEEDS[self.board_period][1]))
            self._put(y, 2, msg, curses.A_DIM)
        for i in range(rows):
            idx = self.top[BOARD] + i
            if idx >= len(items):
                break
            self._draw_row(y + i, w, items[idx], BOARD, idx, time_col="age")
        y += rows
        self._put(y, 0, self.rule(w - 1), self.theme.chrome | curses.A_DIM)
        return y + 1

    def _results_caption(self, w):
        if self.searching:
            cap = " SEARCH  %s ... " % self.last_query
            state = " working "
        else:
            res = self.result
            cap = " SEARCH  %s  M%.1f+  %dd " % (
                res.label, self.search_min_mag, self.search_days)
            state = " %d hits / %s%s " % (
                len(res.quakes), res.note,
                " / strict" if self.strict else "")
        pad = max(1, w - len(cap) - len(state) - 2)
        return cap + self.rule(pad) + state

    def _draw_results(self, y, w, height):
        if height < 3:
            return
        attr = self.theme.chrome
        if self.focus == RESULTS:
            attr = attr | curses.A_REVERSE
        self._put(y, 0, self._results_caption(w), attr)
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
            self._draw_row(y + 2 + i, w, items[idx], RESULTS, idx,
                           time_col="when")

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
        marker = "*" if is_new else " "
        line = "%s %-*s %*s %*s  %-*.*s %-*.*s" % (
            marker, W_AGE, when[:W_AGE], W_MAG, q.mag_text(),
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
            self.status = ("/ search   m board mag   t window   TAB pane   "
                           "ENTER detail   o open   ? help   q quit")
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
        win = curses.newwin(height, width, max(0, (h - height) // 2),
                            max(0, (w - width) // 2))
        win.bkgd(" ", self.theme.pair(1))
        win.erase()
        win.box()
        return win

    HELP = [
        ("/", "search by country or region (e.g. japan, chile, aegean)"),
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
        win = self._window(len(self.HELP) + 6, 74)
        h = win.getmaxyx()[0]
        self._wput(win, 0, 2, " Keys ", self.theme.chrome)
        for i, (key, text) in enumerate(self.HELP):
            if i + 2 >= h - 2:
                break
            self._wput(win, i + 2, 3, "%-13s %s" % (key, text))
        self._wput(win, h - 2, 3,
                   "Data: earthquake.usgs.gov  -  any key to close",
                   curses.A_DIM)
        win.noutrefresh()

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
            ("Local time", "%s (%s)" % (q.local_time(),
                                        humanize_age(q.age_seconds()))),
            ("UTC time", q.utc_time()),
            ("Tsunami flag", "YES - check official advisories" if q.tsunami
             else "no"),
            ("PAGER alert", (q.alert or "none").upper()),
            ("Felt reports", str(q.felt) if q.felt else "none"),
            ("Intensity", "CDI %s / MMI %s" % (q.cdi if q.cdi is not None
                                               else "-",
                                               q.mmi if q.mmi is not None
                                               else "-")),
            ("Significance", str(q.sig) if q.sig is not None else "-"),
            ("Review status", "%s (%s)" % (q.status or "unknown", q.net)),
            ("Event type", q.etype),
            ("Event id", q.id),
        ]
        wrapped = []
        for label, value in rows:
            chunks = textwrap.wrap(str(value), 54) or [""]
            wrapped.append((label, chunks[0]))
            for extra in chunks[1:]:
                wrapped.append(("", extra))
        win = self._window(len(wrapped) + 7, 76)
        h = win.getmaxyx()[0]
        self._wput(win, 0, 2, " Event detail ", self.theme.chrome)
        self._wput(win, 1, 3, q.title or q.place, self.theme.mag(q.tier()))
        for i, (label, value) in enumerate(wrapped):
            if i + 3 >= h - 3:
                break
            self._wput(win, i + 3, 3, "%-14s %s" % (label, value))
        self._wput(win, h - 3, 3, q.url, curses.A_DIM)
        self._wput(win, h - 2, 3,
                   "o open in browser  -  any key to close", curses.A_DIM)
        win.noutrefresh()

    # -- prompts --------------------------------------------------------

    def prompt(self, label, initial=""):
        h, w = self.scr.getmaxyx()
        buf = list(initial)
        curses.curs_set(1)
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
                if ch in (27,):                       # ESC
                    return None
                if ch in (10, 13, curses.KEY_ENTER):
                    return "".join(buf).strip()
                if ch in (curses.KEY_BACKSPACE, 127, 8):
                    if buf:
                        buf.pop()
                    continue
                if ch == curses.KEY_RESIZE:
                    h, w = self.scr.getmaxyx()
                    self.draw()
                    continue
                if ch in (curses.KEY_DC,):
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
        name = "quakes-%s-%s.csv" % (
            "board" if self.focus == BOARD
            else regions.normalize(self.result.label).replace(" ", "_"),
            time.strftime("%Y%m%d-%H%M%S"))
        try:
            with open(name, "w", newline="") as fh:
                out = csv.writer(fh)
                out.writerow(["time_utc", "magnitude", "mag_type", "depth_km",
                              "latitude", "longitude", "place", "tsunami",
                              "alert", "status", "id", "url"])
                for q in items:
                    out.writerow([q.utc_time(), q.mag, q.mag_type, q.depth_km,
                                  q.lat, q.lon, q.place, int(bool(q.tsunami)),
                                  q.alert or "", q.status, q.id, q.url])
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
        except Exception as exc:                     # webbrowser is picky
            self.say("could not open browser: %s" % exc, 8)

    def move(self, delta):
        pane = self.focus
        items = self.pane_items(pane)
        if not items:
            return
        self.sel[pane] = max(0, min(len(items) - 1, self.sel[pane] + delta))
        self._clamp(pane)

    def handle(self, ch):
        if ch == curses.KEY_RESIZE:
            return True
        if self.overlay:
            if ch in (ord("o"), ord("O")) and self.overlay == "detail":
                self.open_browser()
            else:
                self.overlay = None
            return True
        if ch in (ord("q"), ord("Q")):
            return False
        if ch in (9, curses.KEY_BTAB):
            self.focus = RESULTS if (self.focus == BOARD and self.result
                                     is not None) else BOARD
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
                self.first_load = True
                self.refresh_board()
        elif ch == ord("M"):
            value = self.prompt_float("Search minimum magnitude",
                                      self.search_min_mag, -1.0, 10.0)
            if value is not None:
                self.search_min_mag = value
                if self.last_query:
                    self.start_search(self.last_query)
        elif ch in (ord("t"), ord("T")):
            order = api.FEED_ORDER
            self.board_period = order[(order.index(self.board_period) + 1)
                                      % len(order)]
            self.first_load = True
            self.refresh_board()
            self.say("board window: %s" % api.FEEDS[self.board_period][1])
        elif ch in (ord("d"), ord("D")):
            value = self.prompt_float("Search history in days",
                                      self.search_days, 0.05, 365.0)
            if value is not None:
                self.search_days = value
                if self.last_query:
                    self.start_search(self.last_query)
        elif ch in (ord("i"), ord("I")):
            value = self.prompt_float("Auto-refresh seconds",
                                      self.refresh_every, 15.0, 3600.0)
            if value is not None:
                self.refresh_every = value
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
        elif ch in (ord("b"), ord("B")):
            self.bell = not self.bell
            self.say("alert sound %s" % ("on" if self.bell else "off"))
        return True

    # -- main loop ------------------------------------------------------

    def run(self):
        curses.curs_set(0)
        self.scr.timeout(250)
        self.refresh_board()
        if self.opts.query:
            self.start_search(self.opts.query)
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
        self.stop.set()


def launch(opts):
    def main(stdscr):
        App(stdscr, opts).run()
    curses.wrapper(main)
