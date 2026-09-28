"""Plain-text output, for piping, cron jobs or terminals without curses."""

import sys
import time

from . import api, geo, map as worldmap, regions, service
from .model import humanize_age

W_AGE, W_MAG, W_DEPTH, W_PLACE, W_FLAGS = 11, 5, 9, 42, 14


def _header(first="AGE", home=False):
    line = "%-*s %*s %*s  %-*s %-*s" % (
        W_AGE, first, W_MAG, "MAG", W_DEPTH, "DEPTH",
        W_PLACE, "LOCATION", W_FLAGS, "NOTES")
    return line + ("%11s" % "FROM HOME" if home else "")


def _row(q, when, home=None):
    line = "%-*s %*s %*s  %-*.*s %-*.*s" % (
        W_AGE, when[:W_AGE], W_MAG, q.mag_text(), W_DEPTH, q.depth_text(),
        W_PLACE, W_PLACE, q.place, W_FLAGS, W_FLAGS, q.flags())
    if home:
        km = geo.haversine(home[0], home[1], q.lat, q.lon)
        line += "%11s" % (geo.format_km(km) if km is not None else "?")
    return line


def _table(quakes, first, when, home=None):
    width = W_AGE + W_MAG + W_DEPTH + W_PLACE + W_FLAGS + 5 + (11 if home else 0)
    out = [_header(first, bool(home)), "-" * width]
    for q in quakes:
        out.append(_row(q, when(q), home))
    return "\n".join(out)


def print_board(opts, stream=sys.stdout):
    label = api.FEEDS.get(opts.period, api.FEEDS["day"])[1]
    stream.write("LIVE BOARD  M%.1f+  %s  (fetched %s)\n"
                 % (opts.min_mag, label, time.strftime("%Y-%m-%d %H:%M:%S")))
    try:
        fetched = api.fetch_feed(opts.period, opts.min_mag)
    except api.ApiError as exc:
        stream.write("feed unavailable: %s\n" % exc)
        return 1
    quakes = fetched.quakes
    if not quakes:
        stream.write("no events at M%.1f+ in the %s\n" % (opts.min_mag, label))
        return 0
    shown = quakes[:opts.limit] if opts.limit else quakes
    stream.write(_table(shown, "AGE", lambda q: humanize_age(q.age_seconds()),
                        opts.home) + "\n")
    tail = "%d of %d event(s)." % (len(shown), len(quakes)) \
        if len(shown) < len(quakes) else "%d event(s)." % len(quakes)
    if fetched.stale:
        tail += "  [cached copy: the network was unavailable]"
    stream.write("%s  Source: earthquake.usgs.gov\n" % tail)
    return 0


def _run_search(opts):
    if opts.near:
        return service.near(opts.home[0], opts.home[1],
                            radius_km=opts.home_radius_km,
                            min_mag=opts.search_min_mag, days=opts.days,
                            limit=opts.limit or 500,
                            label=getattr(opts, "home_label", None))
    return service.search(opts.query, min_mag=opts.search_min_mag,
                          days=opts.days, limit=opts.limit or 500,
                          strict=opts.strict)


def print_search(opts, stream=sys.stdout):
    try:
        res = _run_search(opts)
    except api.ApiError as exc:
        stream.write("search failed: %s\n" % exc)
        return 1
    except ValueError as exc:
        stream.write("%s\n" % exc)
        return 2
    stream.write("\nSEARCH  %s  M%.1f+  last %g day(s)  [%s]\n"
                 % (res.label, opts.search_min_mag, opts.days, res.note))
    if not res.quakes:
        stream.write("no matching events.\n")
        if not opts.near and not regions.resolve(opts.query):
            tips = regions.suggest(opts.query, 6)
            if tips:
                stream.write("try one of: %s\n"
                             % ", ".join(regions.display_name(t) for t in tips))
        return 0
    stream.write(_table(res.quakes, "WHEN",
                        lambda q: time.strftime("%m-%d %H:%M",
                                                time.localtime(q.epoch)),
                        opts.home) + "\n")
    if res.truncated:
        stream.write("showing %d of %s matching event(s).\n"
                     % (len(res.quakes), "{:,}".format(res.total)))
    else:
        stream.write("%d event(s).\n" % len(res.quakes))
    if res.stale:
        stream.write("[cached copy: the network was unavailable]\n")
    if res.scanned:
        stream.write("(scanned %s events to match the place name)\n"
                     % "{:,}".format(res.scanned))
    return 0


def print_context(opts, stream=sys.stdout):
    query = None if opts.near else opts.query
    center = radius = None
    if opts.near:
        center, radius = opts.home, opts.home_radius_km
    try:
        act = service.activity(query=query, center=center, radius_km=radius,
                               min_mag=opts.search_min_mag)
    except (api.ApiError, ValueError) as exc:
        stream.write("context unavailable: %s\n" % exc)
        return 1
    stream.write("\nCONTEXT  %s  M%.1f+\n" % (act.label, act.min_mag))
    stream.write("  last %g days:  %s\n"
                 % (act.recent_days, "{:,}".format(act.recent)
                    if act.recent is not None else "unknown"))
    stream.write("  last %g days:  %s\n"
                 % (act.baseline_days, "{:,}".format(act.baseline)
                    if act.baseline is not None else "unknown"))
    if act.expected:
        stream.write("  expected in %g days: %.0f\n"
                     % (act.recent_days, act.expected))
    for lo, hi, n in act.bands:
        name = "M%.1f+" % lo if hi is None else "M%.1f-%.1f" % (lo, hi - 0.1)
        stream.write("  %-12s %s\n" % (name, "-" if n is None
                                       else "{:,}".format(n)))
    stream.write("  %s\n" % act.verdict())
    return 0


def print_map(opts, quakes, bounds=None, stream=sys.stdout):
    width = 100
    shot = worldmap.render(quakes, width, 22, bounds=bounds, home=opts.home,
                           ascii_only=not _utf8())
    stream.write("\nMAP  %d event(s) plotted%s\n"
                 % (shot.plotted,
                    ", %d outside the view" % shot.offscreen
                    if shot.offscreen else ""))
    stream.write("\n".join(worldmap.to_text(shot)) + "\n")
    return 0


def _utf8():
    import os
    enc = (os.environ.get("LC_ALL") or os.environ.get("LC_CTYPE")
           or os.environ.get("LANG") or "")
    return "utf-8" in enc.lower() or "utf8" in enc.lower()


def run(opts):
    code = print_board(opts)
    searched = None
    if opts.query or opts.near:
        try:
            searched = _run_search(opts)
        except (api.ApiError, ValueError):
            searched = None
        code = print_search(opts) or code
        if opts.context:
            code = print_context(opts) or code
    if opts.map:
        quakes = searched.quakes if searched and searched.quakes else None
        bounds = None
        if quakes and searched.center:
            lat, lon = searched.center
            dlat = searched.radius_km / 111.0
            bounds = (lat - dlat, lat + dlat, lon - dlat * 2, lon + dlat * 2)
        elif quakes and regions.resolve(searched.query):
            hit = regions.resolve(searched.query)
            if len(hit[1]) == 1:
                bounds = hit[1][0]
        if quakes is None:
            try:
                quakes = api.fetch_feed(opts.period, opts.min_mag).quakes
            except api.ApiError:
                quakes = []
        print_map(opts, quakes, bounds)
    return code


def list_regions(stream=sys.stdout):
    names = sorted(regions.display_name(k) for k in regions.BOXES)
    stream.write("Known countries and regions (%d) - partial names and "
                 "misspellings also work:\n\n" % len(names))
    width = max(len(n) for n in names) + 2
    cols = max(1, 78 // width)
    for i in range(0, len(names), cols):
        stream.write("".join("%-*s" % (width, n)
                             for n in names[i:i + cols]).rstrip() + "\n")
    return 0
