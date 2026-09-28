"""User settings: defaults, a home location and bookmarked searches.

Stored as JSON at ``~/.config/quakeboard/config.json`` (or under
``$XDG_CONFIG_HOME``). A missing or corrupt file is not an error - the
defaults below are used and the file is rewritten on the next save.
"""

import copy
import errno
import json
import os

APP = "quakeboard"

DEFAULTS = {
    "min_mag": 4.0,            # live board floor
    "period": "day",           # live board window
    "interval": 60.0,          # board auto-refresh seconds
    "board_rows": 8,
    "search_min_mag": 2.5,
    "days": 30.0,
    "bell": False,
    "bell_mag": 6.0,
    "home": None,              # {"lat": .., "lon": .., "name": ".."}
    "home_radius_km": 300.0,
    "bookmarks": [],           # [{"query": "japan", "min_mag": 4.0, "days": 30}]
    "watch_mag": 6.0,          # watch mode: notify at or above this
    "watch_regions": [],       # watch mode: only these regions, empty = global
}

MAX_BOOKMARKS = 9


def config_dir():
    base = os.environ.get("XDG_CONFIG_HOME")
    if not base:
        base = os.path.join(os.path.expanduser("~"), ".config")
    return os.path.join(base, APP)


def config_path():
    return os.path.join(config_dir(), "config.json")


def load():
    """Return the settings dict, always complete, never raising."""
    settings = copy.deepcopy(DEFAULTS)
    try:
        with open(config_path()) as fh:
            stored = json.load(fh)
    except (OSError, ValueError):
        return settings
    if not isinstance(stored, dict):
        return settings
    for key, value in stored.items():
        if key in settings:
            settings[key] = value
    settings["bookmarks"] = _clean_bookmarks(settings.get("bookmarks"))
    if not _valid_home(settings.get("home")):
        settings["home"] = None
    return settings


def save(settings):
    """Write settings, returning True on success."""
    path = config_path()
    try:
        os.makedirs(os.path.dirname(path))
    except OSError as exc:
        if exc.errno != errno.EEXIST:
            return False
    keep = dict((k, v) for k, v in settings.items() if k in DEFAULTS)
    tmp = path + ".tmp.%d" % os.getpid()
    try:
        with open(tmp, "w") as fh:
            json.dump(keep, fh, indent=2, sort_keys=True)
            fh.write("\n")
        os.replace(tmp, path)
    except OSError:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        return False
    return True


def _valid_home(home):
    if not isinstance(home, dict):
        return False
    try:
        lat, lon = float(home["lat"]), float(home["lon"])
    except (KeyError, TypeError, ValueError):
        return False
    return -90.0 <= lat <= 90.0 and -180.0 <= lon <= 180.0


def _clean_bookmarks(raw):
    out = []
    if not isinstance(raw, list):
        return out
    for item in raw:
        if isinstance(item, str):
            item = {"query": item}
        if not isinstance(item, dict) or not item.get("query"):
            continue
        entry = {"query": str(item["query"])}
        for key, cast in (("min_mag", float), ("days", float)):
            if item.get(key) is not None:
                try:
                    entry[key] = cast(item[key])
                except (TypeError, ValueError):
                    pass
        if item.get("strict"):
            entry["strict"] = True
        out.append(entry)
        if len(out) >= MAX_BOOKMARKS:
            break
    return out


def add_bookmark(settings, query, min_mag=None, days=None, strict=False):
    """Add or move a bookmark to the front. Returns its 1-based slot."""
    entry = {"query": query}
    if min_mag is not None:
        entry["min_mag"] = float(min_mag)
    if days is not None:
        entry["days"] = float(days)
    if strict:
        entry["strict"] = True
    marks = [b for b in settings.get("bookmarks", [])
             if b.get("query", "").lower() != query.lower()]
    marks.insert(0, entry)
    settings["bookmarks"] = marks[:MAX_BOOKMARKS]
    return 1


def remove_bookmark(settings, slot):
    """Drop the bookmark in a 1-based slot. Returns it, or None."""
    marks = settings.get("bookmarks", [])
    if not (1 <= slot <= len(marks)):
        return None
    return marks.pop(slot - 1)


def set_home(settings, lat, lon, name=None):
    settings["home"] = {"lat": float(lat), "lon": float(lon),
                        "name": name or "home"}
