"""Thin client for the USGS earthquake web services.

Two endpoints are used:

* the pre-baked GeoJSON summary feeds, for the live board (cheap, cached by
  USGS, updated about once a minute);
* the FDSN event query service, for searches with a bounding box, time window
  and magnitude floor.
"""

import json
import ssl
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

from .model import Quake

FEED_BASE = "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary"
QUERY_URL = "https://earthquake.usgs.gov/fdsnws/event/1/query"
USER_AGENT = "quakeboard/1.0 (terminal earthquake monitor)"

# Feed name -> (path fragment, human label, seconds covered).
FEEDS = {
    "hour": ("all_hour", "last hour", 3600),
    "day": ("all_day", "last 24h", 86400),
    "week": ("all_week", "last 7 days", 604800),
    "month": ("all_month", "last 30 days", 2592000),
}
FEED_ORDER = ["hour", "day", "week", "month"]

# Magnitude-filtered feeds exist for 4.5+ and are much smaller; use them when
# the requested floor allows it.
BIG_FEEDS = {
    "hour": "4.5_hour",
    "day": "4.5_day",
    "week": "4.5_week",
    "month": "4.5_month",
}


class ApiError(Exception):
    """Raised when the USGS service cannot be reached or returns garbage."""


def _open(url, timeout):
    req = urllib.request.Request(url, headers={
        "User-Agent": USER_AGENT,
        "Accept": "application/geo+json, application/json",
    })
    try:
        return urllib.request.urlopen(req, timeout=timeout).read()
    except urllib.error.HTTPError as exc:
        if exc.code == 400:
            raise ApiError("the service rejected that query (HTTP 400)")
        if exc.code == 404:
            raise ApiError("feed not found (HTTP 404)")
        raise ApiError("HTTP %s from USGS" % exc.code)
    except urllib.error.URLError as exc:
        raise ApiError("network unreachable: %s" % (exc.reason,))
    except ssl.SSLError as exc:
        raise ApiError("TLS error: %s" % (exc,))
    except OSError as exc:
        raise ApiError("connection failed: %s" % (exc,))


def _fetch_json(url, timeout=20.0, attempts=2):
    last = None
    for n in range(attempts):
        try:
            raw = _open(url, timeout)
        except ApiError as exc:
            last = exc
            if n + 1 < attempts:
                time.sleep(1.0)
            continue
        try:
            return json.loads(raw.decode("utf-8", "replace"))
        except ValueError:
            last = ApiError("malformed response from USGS")
            break
    raise last if last else ApiError("request failed")


def _quakes(payload):
    feats = payload.get("features") or []
    out = [Quake.from_feature(f) for f in feats if isinstance(f, dict)]
    out.sort(key=lambda q: q.epoch, reverse=True)
    return out


def fetch_feed(period="day", min_mag=4.0, timeout=20.0):
    """Return events from a summary feed, newest first, filtered by magnitude."""
    if period not in FEEDS:
        period = "day"
    slug = BIG_FEEDS[period] if min_mag >= 4.5 else FEEDS[period][0]
    url = "%s/%s.geojson" % (FEED_BASE, slug)
    quakes = _quakes(_fetch_json(url, timeout=timeout))
    return [q for q in quakes if q.mag is None or q.magnitude >= min_mag]


def _iso(dt):
    return dt.strftime("%Y-%m-%dT%H:%M:%S")


def search(min_mag=2.5, days=30, bbox=None, limit=500, timeout=25.0,
           max_mag=None, max_depth=None):
    """Query the FDSN event service.

    ``bbox`` is ``(min_lat, max_lat, min_lon, max_lon)``; longitudes may run
    past +/-180 to describe a box that crosses the antimeridian.
    """
    end = datetime.now(timezone.utc)
    start = end - timedelta(days=max(0.01, float(days)))
    params = [
        ("format", "geojson"),
        ("starttime", _iso(start)),
        ("endtime", _iso(end)),
        ("orderby", "time"),
        ("limit", str(max(1, min(int(limit), 20000)))),
    ]
    if min_mag is not None:
        params.append(("minmagnitude", "%g" % min_mag))
    if max_mag is not None:
        params.append(("maxmagnitude", "%g" % max_mag))
    if max_depth is not None:
        params.append(("maxdepth", "%g" % max_depth))
    if bbox:
        min_lat, max_lat, min_lon, max_lon = bbox
        params += [
            ("minlatitude", "%g" % min_lat),
            ("maxlatitude", "%g" % max_lat),
            ("minlongitude", "%g" % min_lon),
            ("maxlongitude", "%g" % max_lon),
        ]
    url = QUERY_URL + "?" + urllib.parse.urlencode(params)
    return _quakes(_fetch_json(url, timeout=timeout))
