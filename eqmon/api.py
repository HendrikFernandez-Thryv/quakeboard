"""Client for the USGS earthquake web services.

Three endpoints are used:

* the pre-baked GeoJSON summary feeds, for the live board (cheap, cached by
  USGS, updated about once a minute);
* the FDSN event *query* service, for searches by bounding box, radius, time
  window and magnitude floor;
* the FDSN event *count* service, which returns a bare number, so "how many
  events are there really?" costs almost nothing.

Responses go through :mod:`eqmon.cache`, which revalidates with ``ETag`` and
falls back to the stored copy when the network is unreachable.
"""

import json
import ssl
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

from . import cache
from .model import Quake

FEED_BASE = "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary"
QUERY_URL = "https://earthquake.usgs.gov/fdsnws/event/1/query"
COUNT_URL = "https://earthquake.usgs.gov/fdsnws/event/1/count"
USER_AGENT = "quakeboard/1.1 (terminal earthquake monitor)"

# The service refuses a query asking for more than this many events.
MAX_EVENTS = 20000

FEEDS = {
    "hour": ("all_hour", "last hour", 3600),
    "day": ("all_day", "last 24h", 86400),
    "week": ("all_week", "last 7 days", 604800),
    "month": ("all_month", "last 30 days", 2592000),
}
FEED_ORDER = ["hour", "day", "week", "month"]

BIG_FEEDS = {
    "hour": "4.5_hour",
    "day": "4.5_day",
    "week": "4.5_week",
    "month": "4.5_month",
}


class ApiError(Exception):
    """The USGS service could not be reached, or returned something unusable."""


class Fetched(object):
    """Events plus how they were obtained.

    ``total`` is the true number of matching events when it is known and
    larger than the number returned; ``stale`` means the network failed and
    this came from the on-disk cache.
    """

    def __init__(self, quakes, total=None, stale=False, cached=False,
                 fetched_at=None):
        self.quakes = quakes
        self.total = total if total is not None else len(quakes)
        self.stale = stale
        self.cached = cached
        self.fetched_at = fetched_at or time.time()

    @property
    def truncated(self):
        return self.total > len(self.quakes)

    def __len__(self):
        return len(self.quakes)

    def __iter__(self):
        return iter(self.quakes)


def _request(url, headers, timeout):
    req = urllib.request.Request(url, headers=headers)
    try:
        resp = urllib.request.urlopen(req, timeout=timeout)
        return (resp.read().decode("utf-8", "replace"),
                resp.headers.get("ETag"), resp.headers.get("Last-Modified"))
    except urllib.error.HTTPError as exc:
        if exc.code == 304:
            return None, None, None        # unchanged; use the cached body
        if exc.code == 400:
            raise ApiError("the service rejected that query (HTTP 400)")
        if exc.code == 404:
            raise ApiError("not found (HTTP 404)")
        if exc.code == 429:
            raise ApiError("rate limited by USGS (HTTP 429) - try again shortly")
        if 500 <= exc.code < 600:
            raise ApiError("USGS service error (HTTP %s)" % exc.code)
        raise ApiError("HTTP %s from USGS" % exc.code)
    except urllib.error.URLError as exc:
        raise ApiError("network unreachable: %s" % (exc.reason,))
    except ssl.SSLError as exc:
        raise ApiError("TLS error: %s" % (exc,))
    except OSError as exc:
        raise ApiError("connection failed: %s" % (exc,))


def fetch_text(url, timeout=20.0, attempts=2, min_age=0.0, allow_stale=True):
    """Fetch a URL as text. Returns ``(body, stale, from_cache)``."""
    entry = cache.load(url)
    if entry and min_age > 0 and cache.age(entry) < min_age:
        return entry["body"], False, True

    headers = {"User-Agent": USER_AGENT,
               "Accept": "application/geo+json, application/json, text/plain"}
    if entry:
        if entry.get("etag"):
            headers["If-None-Match"] = entry["etag"]
        if entry.get("modified"):
            headers["If-Modified-Since"] = entry["modified"]

    last = None
    for n in range(max(1, attempts)):
        try:
            body, etag, modified = _request(url, headers, timeout)
        except ApiError as exc:
            last = exc
            if n + 1 < attempts:
                time.sleep(1.0)
            continue
        if body is None:                    # 304 Not Modified
            cache.touch(url, entry)
            return entry["body"], False, True
        cache.store(url, body, etag, modified)
        return body, False, False

    if entry and allow_stale:
        return entry["body"], True, True
    raise last if last else ApiError("request failed")


def _fetch_json(url, **kw):
    body, stale, cached = fetch_text(url, **kw)
    try:
        return json.loads(body), stale, cached
    except ValueError:
        raise ApiError("malformed response from USGS")


def _quakes(payload):
    feats = payload.get("features") or []
    out = [Quake.from_feature(f) for f in feats if isinstance(f, dict)]
    out.sort(key=lambda q: q.epoch, reverse=True)
    return out


def _iso(dt):
    return dt.strftime("%Y-%m-%dT%H:%M:%S")


def _window(days, start=None, end=None):
    if end is None:
        end = datetime.now(timezone.utc)
    if start is None:
        start = end - timedelta(days=max(0.01, float(days)))
    return start, end


def query_params(min_mag=None, days=30, bbox=None, center=None,
                 radius_km=None, limit=500, max_mag=None, max_depth=None,
                 min_depth=None, end=None, start=None):
    """Build the shared FDSN parameter list for query and count."""
    start, end = _window(days, start, end)
    params = [("format", "geojson"),
              ("starttime", _iso(start)),
              ("endtime", _iso(end))]
    if min_mag is not None:
        params.append(("minmagnitude", "%g" % min_mag))
    if max_mag is not None:
        params.append(("maxmagnitude", "%g" % max_mag))
    if min_depth is not None:
        params.append(("mindepth", "%g" % min_depth))
    if max_depth is not None:
        params.append(("maxdepth", "%g" % max_depth))
    if center and radius_km:
        params += [("latitude", "%g" % center[0]),
                   ("longitude", "%g" % center[1]),
                   ("maxradiuskm", "%g" % radius_km)]
    elif bbox:
        min_lat, max_lat, min_lon, max_lon = bbox
        params += [("minlatitude", "%g" % min_lat),
                   ("maxlatitude", "%g" % max_lat),
                   ("minlongitude", "%g" % min_lon),
                   ("maxlongitude", "%g" % max_lon)]
    if limit is not None:
        params += [("orderby", "time"),
                   ("limit", str(max(1, min(int(limit), MAX_EVENTS))))]
    return params


def count(timeout=20.0, min_age=300.0, **kw):
    """How many events match, without downloading them.

    Returns ``None`` rather than raising, since this only ever adds context.
    """
    kw["limit"] = None
    url = COUNT_URL + "?" + urllib.parse.urlencode(query_params(**kw))
    try:
        payload, _, _ = _fetch_json(url, timeout=timeout, attempts=1,
                                    min_age=min_age)
    except ApiError:
        return None
    value = payload.get("count") if isinstance(payload, dict) else None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def search(min_mag=2.5, days=30, bbox=None, center=None, radius_km=None,
           limit=500, timeout=25.0, max_mag=None, max_depth=None,
           min_depth=None, end=None, start=None, min_age=30.0,
           with_total=True):
    """Query the FDSN event service.

    ``bbox`` is ``(min_lat, max_lat, min_lon, max_lon)`` and may run past
    +/-180 to cross the antimeridian; ``center`` with ``radius_km`` searches a
    circle instead, which is what you want around a point.
    """
    kw = dict(min_mag=min_mag, days=days, bbox=bbox, center=center,
              radius_km=radius_km, max_mag=max_mag, max_depth=max_depth,
              min_depth=min_depth, end=end, start=start)
    url = QUERY_URL + "?" + urllib.parse.urlencode(
        query_params(limit=limit, **kw))
    payload, stale, cached = _fetch_json(url, timeout=timeout, min_age=min_age)
    quakes = _quakes(payload)
    total = None
    if with_total and len(quakes) >= (limit or MAX_EVENTS):
        total = count(**kw)                 # only worth asking if we hit the cap
    return Fetched(quakes, total=total, stale=stale, cached=cached)


def fetch_feed(period="day", min_mag=4.0, timeout=20.0, min_age=0.0):
    """Events from a summary feed, newest first, filtered by magnitude."""
    if period not in FEEDS:
        period = "day"
    slug = BIG_FEEDS[period] if min_mag >= 4.5 else FEEDS[period][0]
    url = "%s/%s.geojson" % (FEED_BASE, slug)
    payload, stale, cached = _fetch_json(url, timeout=timeout, min_age=min_age)
    quakes = [q for q in _quakes(payload)
              if q.mag is None or q.magnitude >= min_mag]
    return Fetched(quakes, stale=stale, cached=cached)
