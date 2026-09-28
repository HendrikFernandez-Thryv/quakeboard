"""Plain-text output, for piping, cron jobs or terminals without curses."""

import sys
import time

from . import api, regions, service
from .model import humanize_age

W_AGE, W_MAG, W_DEPTH, W_PLACE, W_FLAGS = 11, 5, 9, 42, 14


def _header(first="AGE"):
    return "%-*s %*s %*s  %-*s %-*s" % (
        W_AGE, first, W_MAG, "MAG", W_DEPTH, "DEPTH",
        W_PLACE, "LOCATION", W_FLAGS, "NOTES")


def _row(q, when):
    return "%-*s %*s %*s  %-*.*s %-*.*s" % (
        W_AGE, when[:W_AGE], W_MAG, q.mag_text(), W_DEPTH, q.depth_text(),
        W_PLACE, W_PLACE, q.place, W_FLAGS, W_FLAGS, q.flags())


def _table(quakes, first, when):
    line = "-" * (W_AGE + W_MAG + W_DEPTH + W_PLACE + W_FLAGS + 5)
    out = [_header(first), line]
    for q in quakes:
        out.append(_row(q, when(q)))
    return "\n".join(out)


def print_board(opts, stream=sys.stdout):
    label = api.FEEDS.get(opts.period, api.FEEDS["day"])[1]
    stream.write("LIVE BOARD  M%.1f+  %s  (fetched %s)\n"
                 % (opts.min_mag, label, time.strftime("%Y-%m-%d %H:%M:%S")))
    try:
        quakes = api.fetch_feed(opts.period, opts.min_mag)
    except api.ApiError as exc:
        stream.write("feed unavailable: %s\n" % exc)
        return 1
    if not quakes:
        stream.write("no events at M%.1f+ in the %s\n" % (opts.min_mag, label))
        return 0
    if opts.limit:
        quakes = quakes[:opts.limit]
    stream.write(_table(quakes, "AGE",
                        lambda q: humanize_age(q.age_seconds())) + "\n")
    stream.write("%d event(s). Source: earthquake.usgs.gov\n" % len(quakes))
    return 0


def print_search(opts, stream=sys.stdout):
    try:
        res = service.search(opts.query, min_mag=opts.search_min_mag,
                             days=opts.days, limit=opts.limit or 500,
                             strict=opts.strict)
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
        tips = regions.suggest(opts.query, 6)
        if tips and not regions.resolve(opts.query):
            stream.write("try one of: %s\n"
                         % ", ".join(regions.display_name(t) for t in tips))
        return 0
    stream.write(_table(res.quakes, "WHEN",
                        lambda q: time.strftime("%m-%d %H:%M",
                                                time.localtime(q.epoch))) + "\n")
    stream.write("%d event(s).\n" % len(res.quakes))
    return 0


def run(opts):
    code = print_board(opts)
    if opts.query:
        code = print_search(opts) or code
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
