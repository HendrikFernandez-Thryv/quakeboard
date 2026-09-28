"""A small on-disk HTTP cache, so repeat queries do not re-download.

The USGS feeds set ``ETag`` and ``Last-Modified``, so a revalidation costs a
304 and no body. Entries are also served straight from disk while they are
younger than ``min_age``, which covers flipping between the same two searches.
"""

import errno
import hashlib
import json
import os
import time

APP = "quakeboard"


def cache_dir():
    base = os.environ.get("XDG_CACHE_HOME")
    if not base:
        base = os.path.join(os.path.expanduser("~"), ".cache")
    return os.path.join(base, APP)


def _path(url):
    digest = hashlib.sha1(url.encode("utf-8")).hexdigest()
    return os.path.join(cache_dir(), digest + ".json")


def load(url):
    """Return a cached entry dict, or ``None``.

    Keys: ``body`` (text), ``etag``, ``modified``, ``fetched`` (epoch).
    """
    try:
        with open(_path(url)) as fh:
            entry = json.load(fh)
    except (OSError, ValueError):
        return None
    if not isinstance(entry, dict) or "body" not in entry:
        return None
    return entry


def store(url, body, etag=None, modified=None):
    path = _path(url)
    entry = {"body": body, "etag": etag, "modified": modified,
             "fetched": time.time(), "url": url}
    try:
        os.makedirs(os.path.dirname(path))
    except OSError as exc:
        if exc.errno != errno.EEXIST:
            return False
    tmp = path + ".tmp.%d" % os.getpid()
    try:
        with open(tmp, "w") as fh:
            json.dump(entry, fh)
        os.replace(tmp, path)      # atomic, so a reader never sees a half file
    except OSError:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        return False
    return True


def age(entry):
    return time.time() - float(entry.get("fetched") or 0)


def touch(url, entry):
    """Mark an entry as revalidated just now (after a 304)."""
    entry["fetched"] = time.time()
    store(url, entry["body"], entry.get("etag"), entry.get("modified"))


def clear():
    """Delete every cached response. Returns the number of files removed."""
    removed = 0
    try:
        names = os.listdir(cache_dir())
    except OSError:
        return 0
    for name in names:
        if not name.endswith(".json"):
            continue
        try:
            os.unlink(os.path.join(cache_dir(), name))
            removed += 1
        except OSError:
            pass
    return removed


def stats():
    """``(file_count, total_bytes)`` for the cache directory."""
    count = total = 0
    try:
        names = os.listdir(cache_dir())
    except OSError:
        return 0, 0
    for name in names:
        try:
            total += os.path.getsize(os.path.join(cache_dir(), name))
            count += 1
        except OSError:
            pass
    return count, total
