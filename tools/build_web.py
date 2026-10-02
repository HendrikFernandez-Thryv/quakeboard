#!/usr/bin/env python3
"""Assemble web/index.html, one self-contained file, from web/src.

    python3 tools/build_web.py           # write web/index.html
    python3 tools/build_web.py --check   # exit 1 if index.html is out of date

The page has no build step of its own and no dependencies; this script only
concatenates the stylesheet and scripts into the template so the whole app can
be opened, copied or hosted as a single file.
"""

import argparse
import glob
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "web", "src")
OUT = os.path.join(ROOT, "web", "index.html")

# Order matters: later files use what earlier ones define.
SCRIPTS = [
    "gazetteer.js", "landdata.js", "core.js", "land.js",
    "fx-common.js", "fx-seismo.js", "fx-map-core.js", "fx-map-views.js", "fx-charts.js",
    "app-util.js", "app-list.js", "app-detail.js", "app-panels.js", "app-main.js",
]


def read(path):
    with open(path, encoding="utf-8") as fh:
        return fh.read()


def build():
    css = "\n".join(read(p) for p in sorted(glob.glob(os.path.join(SRC, "css", "*.css"))))
    parts = []
    for name in SCRIPTS:
        path = os.path.join(SRC, name)
        if not os.path.exists(path):
            continue
        text = read(path)
        # An inline </script> in a string would end the block early.
        if re.search(r"</script", text, re.I):
            sys.exit("%s contains '</script'; escape it as '<\\/script'" % name)
        parts.append("/* ==== %s ==== */\n%s" % (name, text.rstrip()))
    if re.search(r"</style", css, re.I):
        sys.exit("a stylesheet contains '</style'")
    html = read(os.path.join(SRC, "template.html"))
    # The template is written with \uXXXX escapes for non-ASCII; resolve them
    # in the markup only, never inside the scripts.
    html = re.sub(r"\\u([0-9a-fA-F]{4})", lambda m: chr(int(m.group(1), 16)), html)
    # callable replacements: no backslash processing of the inserted text
    html = html.replace("/*@STYLE@*/", css, 1)
    html = html.replace("/*@SCRIPT@*/", "\n\n".join(parts), 1)
    return html


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    ap.add_argument("--check", action="store_true", help="do not write; fail if out of date")
    args = ap.parse_args()
    html = build()
    if args.check:
        if not os.path.exists(OUT) or read(OUT) != html:
            sys.exit("web/index.html is out of date - run: python3 tools/build_web.py")
        print("web/index.html is up to date")
        return
    with open(OUT, "w", encoding="utf-8") as fh:
        fh.write(html)
    print("wrote %s  (%.1f kB)" % (os.path.relpath(OUT, ROOT), len(html.encode("utf-8")) / 1024.0))


if __name__ == "__main__":
    main()
