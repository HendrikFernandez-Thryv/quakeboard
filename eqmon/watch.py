"""Background watch mode: poll the feed and raise a desktop notification.

Runs without the full-screen UI, so it is the thing to leave in a spare
terminal, a ``launchd`` job or a ``tmux`` pane. Events already reported are
remembered on disk, so restarting does not re-announce them.
"""

import json
import os
import shutil
import subprocess
import sys
import time

from . import api, cache, geo, regions
from .model import humanize_age

STATE_FILE = "watch-seen.json"
STATE_MAX = 2000


def _state_path():
    return os.path.join(cache.cache_dir(), STATE_FILE)


def load_seen():
    try:
        with open(_state_path()) as fh:
            data = json.load(fh)
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def save_seen(seen):
    if len(seen) > STATE_MAX:            # keep the most recent ids only
        newest = sorted(seen.items(), key=lambda kv: kv[1], reverse=True)
        seen = dict(newest[:STATE_MAX])
    path = _state_path()
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        tmp = path + ".tmp.%d" % os.getpid()
        with open(tmp, "w") as fh:
            json.dump(seen, fh)
        os.replace(tmp, path)
    except OSError:
        pass
    return seen


# --- notifiers ------------------------------------------------------------

def _osascript(title, message):
    def esc(text):
        return text.replace("\\", "\\\\").replace('"', '\\"')
    script = 'display notification "%s" with title "%s"' % (esc(message),
                                                            esc(title))
    subprocess.run(["osascript", "-e", script], check=False,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def _notify_send(title, message):
    subprocess.run(["notify-send", title, message], check=False,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def pick_notifier():
    """Return ``(function, name)`` for the best desktop notifier available."""
    if sys.platform == "darwin" and shutil.which("osascript"):
        return _osascript, "macOS notification centre"
    if shutil.which("notify-send"):
        return _notify_send, "notify-send"
    return None, "terminal only"


# --- filtering ------------------------------------------------------------

class Filter(object):
    """Which events this watcher cares about."""

    def __init__(self, min_mag=6.0, region_names=None, home=None,
                 radius_km=None):
        self.min_mag = min_mag
        self.names = []
        self.boxes = []
        for name in region_names or []:
            hit = regions.resolve(name)
            if not hit:
                raise ValueError("unknown region: %s" % name)
            key, boxes, _ = hit
            self.names.append(regions.display_name(key))
            self.boxes.extend(boxes)
        self.home = home
        self.radius_km = radius_km

    def describe(self):
        where = "worldwide"
        if self.names:
            where = ", ".join(self.names)
        elif self.home and self.radius_km:
            where = "within %s of %.3f, %.3f" % (
                geo.format_km(self.radius_km), self.home[0], self.home[1])
        return "M%.1f+ %s" % (self.min_mag, where)

    def matches(self, quake):
        if quake.mag is None or quake.magnitude < self.min_mag:
            return False
        if self.boxes:
            return any(regions.box_contains(b, quake.lat, quake.lon)
                       for b in self.boxes)
        if self.home and self.radius_km:
            km = geo.haversine(self.home[0], self.home[1], quake.lat, quake.lon)
            return km is not None and km <= self.radius_km
        return True


def _line(quake, home=None):
    extra = ""
    if home:
        km = geo.haversine(home[0], home[1], quake.lat, quake.lon)
        if km is not None:
            extra = "  [%s %s away]" % (
                geo.format_km(km),
                geo.direction_from(home[0], home[1], quake.lat, quake.lon))
    return "%s  M%s  %s  depth %s  (%s)%s" % (
        time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(quake.epoch)),
        quake.mag_text().strip(), quake.place, quake.depth_text(),
        humanize_age(quake.age_seconds()), extra)


def run(opts, stream=sys.stdout):
    """Poll until interrupted. Returns an exit code."""
    try:
        flt = Filter(min_mag=opts.watch_mag,
                     region_names=opts.watch_regions,
                     home=opts.home, radius_km=opts.home_radius_km)
    except ValueError as exc:
        stream.write("%s\n" % exc)
        return 2

    notify, notifier_name = pick_notifier()
    interval = max(15.0, opts.interval)
    stream.write("Watching %s, polling every %gs via %s.\n"
                 % (flt.describe(), interval, notifier_name))
    stream.write("Press Ctrl-C to stop.\n\n")
    stream.flush()

    seen = load_seen()
    first_pass = not seen
    errors = 0
    try:
        while True:
            try:
                fetched = api.fetch_feed(opts.period, min(4.0, flt.min_mag))
                errors = 0
            except api.ApiError as exc:
                errors += 1
                stream.write("%s  feed unavailable: %s\n"
                             % (time.strftime("%H:%M:%S"), exc))
                stream.flush()
                time.sleep(min(300.0, interval * (2 ** min(errors, 4))))
                continue

            fresh = []
            for q in fetched.quakes:
                if q.id in seen or not flt.matches(q):
                    continue
                seen[q.id] = time.time()
                fresh.append(q)

            # The first run would otherwise announce the whole backlog.
            if first_pass:
                first_pass = False
                stream.write("%s  baseline: %d matching event(s) already in "
                             "the feed, not notifying for those.\n"
                             % (time.strftime("%H:%M:%S"), len(fresh)))
                for q in sorted(fresh, key=lambda q: q.epoch):
                    stream.write("    %s\n" % _line(q, opts.home))
                fresh = []

            for q in sorted(fresh, key=lambda q: q.epoch):
                stream.write("%s\n" % _line(q, opts.home))
                if notify:
                    title = "M%s earthquake" % q.mag_text().strip()
                    if q.tsunami:
                        title += " - tsunami flag"
                    notify(title, "%s, %s" % (q.place, q.depth_text()))
                else:
                    stream.write("\a")
            if fresh:
                save_seen(seen)
            stream.flush()
            time.sleep(interval)
    except KeyboardInterrupt:
        save_seen(seen)
        stream.write("\nStopped.\n")
        return 0
