"""Command line entry point."""

import argparse
import sys

from . import __version__, plain


def build_parser():
    p = argparse.ArgumentParser(
        prog="quakeboard",
        description="Live earthquake monitor for the terminal, using the "
                    "USGS earthquake feeds.",
        epilog="Interactive keys: / search, m board magnitude, t time window, "
               "TAB switch pane, ENTER detail, o open page, e export CSV, "
               "? help, q quit.")
    p.add_argument("query", nargs="?", default=None,
                   help="country or region to search on start "
                        "(e.g. japan, chile, aegean, 'ring of fire')")
    board = p.add_argument_group("live board")
    board.add_argument("-M", "--min-mag", type=float, default=4.0,
                       metavar="X", help="board magnitude floor (default 4.0)")
    board.add_argument("-p", "--period", default="day",
                       choices=["hour", "day", "week", "month"],
                       help="board time window (default day)")
    board.add_argument("-i", "--interval", type=float, default=60.0,
                       metavar="SEC",
                       help="auto-refresh seconds, minimum 15 (default 60)")
    board.add_argument("--board-rows", type=int, default=8, metavar="N",
                       help="rows of live board to show (default 8)")
    board.add_argument("--bell", action="store_true",
                       help="beep when a new event at or above --bell-mag lands")
    board.add_argument("--bell-mag", type=float, default=6.0, metavar="X",
                       help="magnitude that triggers the beep (default 6.0)")
    srch = p.add_argument_group("search")
    srch.add_argument("-m", "--search-min-mag", type=float, default=2.5,
                      metavar="X",
                      help="magnitude floor for searches (default 2.5)")
    srch.add_argument("-d", "--days", type=float, default=30.0, metavar="N",
                      help="days of history to search (default 30)")
    srch.add_argument("--strict", action="store_true",
                      help="also require the place name to contain the query")
    out = p.add_argument_group("output")
    out.add_argument("--plain", action="store_true",
                     help="print once as plain text and exit, no full-screen UI")
    out.add_argument("-n", "--limit", type=int, default=0, metavar="N",
                     help="cap the number of rows printed in --plain mode")
    out.add_argument("--list-regions", action="store_true",
                     help="list the known country and region names, then exit")
    out.add_argument("-V", "--version", action="version",
                     version="quakeboard %s" % __version__)
    return p


def main(argv=None):
    opts = build_parser().parse_args(argv)
    if opts.list_regions:
        return plain.list_regions()
    if opts.interval < 15:
        opts.interval = 15.0
    if opts.plain or not sys.stdout.isatty():
        return plain.run(opts)
    from . import ui
    try:
        ui.launch(opts)
    except KeyboardInterrupt:
        return 130
    return 0
