"""Command line entry point."""

import argparse
import sys

from . import __version__, cache, config, geo, plain


def build_parser(defaults):
    p = argparse.ArgumentParser(
        prog="quakeboard",
        description="Live earthquake monitor for the terminal, using the "
                    "USGS earthquake feeds.",
        epilog="Interactive keys: / search, n near me, a aftershocks, g map, "
               "x context, 1-9 saved searches, ? help, q quit. "
               "Settings live in %s." % config.config_path())
    p.add_argument("query", nargs="?", default=None,
                   help="country or region to search on start "
                        "(e.g. japan, chile, aegean, 'ring of fire')")

    board = p.add_argument_group("live board")
    board.add_argument("-M", "--min-mag", type=float,
                       default=defaults["min_mag"], metavar="X",
                       help="board magnitude floor (default %(default)s)")
    board.add_argument("-p", "--period", default=defaults["period"],
                       choices=["hour", "day", "week", "month"],
                       help="board time window (default %(default)s)")
    board.add_argument("-i", "--interval", type=float,
                       default=defaults["interval"], metavar="SEC",
                       help="auto-refresh seconds, minimum 15 "
                            "(default %(default)s)")
    board.add_argument("--board-rows", type=int,
                       default=defaults["board_rows"], metavar="N",
                       help="rows of live board to show (default %(default)s)")
    board.add_argument("--bell", action="store_true", default=defaults["bell"],
                       help="beep when a new event at or above --bell-mag lands")
    board.add_argument("--bell-mag", type=float, default=defaults["bell_mag"],
                       metavar="X",
                       help="magnitude that triggers the beep "
                            "(default %(default)s)")

    srch = p.add_argument_group("search")
    srch.add_argument("-m", "--search-min-mag", type=float,
                      default=defaults["search_min_mag"], metavar="X",
                      help="magnitude floor for searches (default %(default)s)")
    srch.add_argument("-d", "--days", type=float, default=defaults["days"],
                      metavar="N",
                      help="days of history to search (default %(default)s)")
    srch.add_argument("--strict", action="store_true",
                      help="also require the place name to contain the query")
    srch.add_argument("--near", action="store_true",
                      help="search around your home location instead")

    loc = p.add_argument_group("location")
    loc.add_argument("--home", metavar="LAT,LON",
                     help="set your home location and save it")
    loc.add_argument("--home-name", metavar="NAME",
                     help="a label for that location")
    loc.add_argument("--radius", type=float,
                     default=defaults["home_radius_km"], metavar="KM",
                     help="radius for --near (default %(default)s)")

    wat = p.add_argument_group("watch mode")
    wat.add_argument("--watch", action="store_true",
                     help="poll in the background and raise a desktop "
                          "notification for new events; no full-screen UI")
    wat.add_argument("--watch-mag", type=float, default=defaults["watch_mag"],
                     metavar="X",
                     help="notify at or above this magnitude "
                          "(default %(default)s)")
    wat.add_argument("--watch-region", action="append", default=None,
                     metavar="NAME",
                     help="only notify for this region; repeatable")

    out = p.add_argument_group("output")
    out.add_argument("--plain", action="store_true",
                     help="print once as plain text and exit, no full-screen UI")
    out.add_argument("--map", action="store_true",
                     help="show the world map (in --plain mode, print it)")
    out.add_argument("--context", action="store_true",
                     help="in --plain mode, also report how the searched "
                          "region compares with its last 12 months")
    out.add_argument("-n", "--limit", type=int, default=0, metavar="N",
                     help="cap the number of rows printed in --plain mode")
    out.add_argument("--list-regions", action="store_true",
                     help="list the known country and region names, then exit")
    out.add_argument("--clear-cache", action="store_true",
                     help="delete cached responses, then exit")
    out.add_argument("-V", "--version", action="version",
                     version="quakeboard %s" % __version__)
    return p


def main(argv=None):
    settings = config.load()
    opts = build_parser(settings).parse_args(argv)

    if opts.list_regions:
        return plain.list_regions()
    if opts.clear_cache:
        files, size = cache.stats()
        removed = cache.clear()
        sys.stdout.write("removed %d cached response(s), %.1f kB, from %s\n"
                         % (removed, size / 1024.0, cache.cache_dir()))
        return 0

    if opts.interval < 15:
        opts.interval = 15.0

    # --home both sets and persists the location.
    if opts.home:
        try:
            lat, lon = geo.parse_latlon(opts.home)
        except ValueError as exc:
            sys.stderr.write("%s\n" % exc)
            return 2
        config.set_home(settings, lat, lon, opts.home_name)
        settings["home_radius_km"] = opts.radius
        if config.save(settings):
            sys.stdout.write("home saved as %s (%.4f, %.4f) in %s\n"
                             % (settings["home"]["name"], lat, lon,
                                config.config_path()))
    home = settings.get("home") or None
    opts.home = (home["lat"], home["lon"]) if home else None
    opts.home_label = home.get("name") if home else None
    opts.home_radius_km = opts.radius
    opts.watch_regions = opts.watch_region or settings.get("watch_regions") or []

    if opts.near and not opts.home:
        sys.stderr.write("no home location set - use --home LAT,LON first\n")
        return 2

    if opts.watch:
        from . import watch
        return watch.run(opts)

    # Persist the flags that are also settings, so the next run remembers.
    for key, value in (("min_mag", opts.min_mag), ("period", opts.period),
                       ("interval", opts.interval), ("days", opts.days),
                       ("search_min_mag", opts.search_min_mag),
                       ("board_rows", opts.board_rows),
                       ("home_radius_km", opts.radius)):
        settings[key] = value

    if opts.plain or not sys.stdout.isatty():
        return plain.run(opts)
    from . import ui
    try:
        ui.launch(opts, settings)
    except KeyboardInterrupt:
        return 130
    return 0
