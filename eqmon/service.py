"""Search and analysis: turn a question into a list of events, or a verdict."""

import math
import time
from datetime import datetime, timedelta, timezone

from . import api, geo, regions

# A text search has to be filtered client side, since FDSN cannot match on
# place names. This caps how much we are willing to pull down to do that.
TEXT_SCAN_LIMIT = 6000


class SearchResult(object):
    def __init__(self, query, quakes, label, note="", total=None, stale=False,
                 center=None, radius_km=None, scanned=None):
        self.query = query
        self.quakes = quakes
        self.label = label          # resolved region name, or the raw text
        self.note = note            # how the query was interpreted
        self.total = len(quakes) if total is None else total
        self.stale = stale
        self.center = center        # (lat, lon) for radius searches
        self.radius_km = radius_km
        self.scanned = scanned      # events examined for a text search

    @property
    def truncated(self):
        return self.total > len(self.quakes)


def _dedupe(quakes):
    seen, out = set(), []
    for q in quakes:
        if q.id in seen:
            continue
        seen.add(q.id)
        out.append(q)
    out.sort(key=lambda q: q.epoch, reverse=True)
    return out


def search(query, min_mag=2.5, days=30, limit=500, strict=False):
    """Search by country/region name, or by free text against the place field.

    A name that resolves in the gazetteer is queried geographically, which
    catches offshore events the USGS labels by sea or trench rather than by
    country. Anything else falls back to a text match on the place string.
    """
    query = (query or "").strip()
    if not query:
        raise ValueError("empty search")

    hit = regions.resolve(query)
    if hit:
        return _region_search(query, hit, min_mag, days, limit, strict)
    return _text_search(query, min_mag, days, limit)


def _region_search(query, hit, min_mag, days, limit, strict):
    key, boxes, how = hit
    label = regions.display_name(key)
    per_box = max(20, int(limit / max(1, len(boxes))))
    found, total, stale = [], 0, False
    for box in boxes:
        res = api.search(min_mag=min_mag, days=days, bbox=box, limit=per_box)
        found.extend(res.quakes)
        total += res.total
        stale = stale or res.stale
    found = _dedupe(found)
    total = max(total, len(found))

    if how == "exact":
        note = "region match"
    elif how == "partial":
        note = 'closest match to "%s"' % query
    else:
        note = 'best guess for "%s"' % query
    if strict:
        needle = regions.normalize(query)
        found = [q for q in found if needle in regions.normalize(q.place)]
        note += ", name-filtered"
        total = len(found)
    return SearchResult(query, found[:limit], label, note, total=total,
                        stale=stale)


def _text_search(query, min_mag, days, limit):
    """Filter on the place string, scanning as little as we can get away with.

    FDSN has no text predicate, so this has to pull events and match locally.
    The count endpoint tells us up front how big that would be, and the
    magnitude floor is raised rather than quietly downloading everything.
    """
    needle = regions.normalize(query)
    available = api.count(min_mag=min_mag, days=days)
    floor, note_extra = min_mag, ""
    if available and available > TEXT_SCAN_LIMIT:
        # Step the floor up until the scan is a reasonable size.
        for bump in (0.5, 1.0, 1.5, 2.0, 2.5, 3.0):
            probe = api.count(min_mag=min_mag + bump, days=days)
            if probe is not None and probe <= TEXT_SCAN_LIMIT:
                floor = min_mag + bump
                note_extra = (" (scan narrowed to M%.1f+: %s events matched "
                              "M%.1f+ over %gd)"
                              % (floor, "{:,}".format(available), min_mag, days))
                break
        else:
            floor = min_mag + 3.0
            note_extra = " (scan narrowed to M%.1f+)" % floor

    res = api.search(min_mag=floor, days=days, limit=TEXT_SCAN_LIMIT,
                     with_total=False)
    matched = [q for q in res.quakes if needle in regions.normalize(q.place)]
    matched = _dedupe(matched)
    return SearchResult(query, matched[:limit], query,
                        "text match on place name" + note_extra,
                        total=len(matched), stale=res.stale,
                        scanned=len(res.quakes))


def near(lat, lon, radius_km=300.0, min_mag=2.5, days=30, limit=500,
         label=None):
    """Search a circle around a point - the right shape for 'near me'."""
    res = api.search(min_mag=min_mag, days=days, center=(lat, lon),
                     radius_km=radius_km, limit=limit)
    name = label or "%.3f, %.3f" % (lat, lon)
    return SearchResult("near %s" % name, res.quakes, name,
                        "within %s" % geo.format_km(radius_km),
                        total=res.total, stale=res.stale,
                        center=(lat, lon), radius_km=radius_km)


# --- aftershock sequences -------------------------------------------------

def aftershock_radius_km(magnitude):
    """A plausible aftershock-zone radius for a mainshock magnitude.

    Surface rupture length from Wells & Coppersmith (1994),
    ``log10(L) = 0.59 M - 2.44``, widened by half again and floored at 25 km
    so small events still get a sensible neighbourhood.
    """
    if magnitude is None or magnitude < 0:
        return 25.0
    length = 10.0 ** (0.59 * float(magnitude) - 2.44)
    return max(25.0, min(400.0, 1.5 * length))


class Sequence(object):
    """What happened around one event, before and after it."""

    def __init__(self, main, radius_km, days, before, after, stale=False,
                 min_mag=None):
        self.main = main
        self.radius_km = radius_km
        self.days = days
        self.min_mag = min_mag
        self.foreshocks = before
        self.aftershocks = after
        self.stale = stale

    @property
    def largest(self):
        return max(self.aftershocks, key=lambda q: q.magnitude) \
            if self.aftershocks else None

    @property
    def largest_foreshock(self):
        return max(self.foreshocks, key=lambda q: q.magnitude) \
            if self.foreshocks else None

    def counts_by_day(self, buckets=7):
        """Aftershocks per 24h since the mainshock, oldest bucket first."""
        out = [0] * buckets
        for q in self.aftershocks:
            day = int((q.epoch - self.main.epoch) // 86400)
            if 0 <= day < buckets:
                out[day] += 1
        return out

    @property
    def rate_first_day(self):
        return sum(1 for q in self.aftershocks
                   if q.epoch - self.main.epoch <= 86400)

    @property
    def rate_last_day(self):
        now = time.time()
        return sum(1 for q in self.aftershocks if now - q.epoch <= 86400)

    @property
    def elapsed_days(self):
        return max(0.0, (time.time() - self.main.epoch) / 86400.0)

    def bath_gap(self):
        """Mainshock magnitude minus largest aftershock.

        Bath's law puts this near 1.2 on average; a much smaller gap is a
        hint the 'mainshock' may not be the biggest event yet.
        """
        big = self.largest
        if big is None or self.main.mag is None:
            return None
        return self.main.magnitude - big.magnitude

    def verdict(self):
        """One plain sentence about where the sequence stands."""
        if not self.aftershocks:
            note = ("No aftershocks recorded above the search magnitude - "
                    "either it is quiet or smaller events are below the floor.")
            fore = self.largest_foreshock
            if (fore is not None and self.main.mag is not None
                    and fore.magnitude > self.main.magnitude):
                note += (" A larger event (M%s) came first, so this looks like "
                         "an aftershock itself." % fore.mag_text().strip())
            return note
        gap = self.bath_gap()
        parts = []
        fore = self.largest_foreshock
        if (fore is not None and self.main.mag is not None
                and fore.magnitude > self.main.magnitude):
            parts.append("A larger event (M%s) came first, so this is part of "
                         "that sequence rather than its mainshock."
                         % fore.mag_text().strip())
        if self.elapsed_days < 1.0:
            parts.append("Still in the first 24 hours, when the rate is "
                         "highest and revisions are common.")
        elif self.rate_last_day == 0:
            parts.append("Nothing in the last 24 hours - the sequence looks "
                         "to have quietened down.")
        elif self.rate_first_day and self.rate_last_day:
            ratio = float(self.rate_last_day) / self.rate_first_day
            if ratio < 0.34:
                parts.append("The rate is decaying as you would expect, from "
                             "%d on day one to %d in the last 24 hours."
                             % (self.rate_first_day, self.rate_last_day))
            elif ratio > 1.5:
                parts.append("The rate is higher now (%d in 24h) than on day "
                             "one (%d) - worth watching."
                             % (self.rate_last_day, self.rate_first_day))
            else:
                parts.append("The rate is holding roughly steady at %d per day."
                             % self.rate_last_day)
        if gap is not None and gap < 0:
            parts.append("A later event was larger, so this was a foreshock.")
        elif gap is not None and gap < 0.5:
            parts.append("The largest aftershock is within %.1f of the "
                         "mainshock, closer than the usual gap of about 1.2."
                         % gap)
        return " ".join(parts) or "Sequence in progress."


def sequence(main, radius_km=None, days=None, min_mag=None, limit=2000):
    """Find the foreshocks and aftershocks around an event."""
    if main.lat is None or main.lon is None:
        raise ValueError("this event has no coordinates")
    radius_km = radius_km or aftershock_radius_km(main.magnitude)
    if days is None:
        days = max(7.0, min(90.0, (time.time() - main.epoch) / 86400.0 + 1.0))
    if min_mag is None:
        # Roughly three units below the mainshock keeps the list informative
        # without dragging in every microquake the network recorded.
        min_mag = max(1.0, (main.magnitude - 3.0) if main.mag else 1.0)

    end = datetime.now(timezone.utc)
    start = datetime.fromtimestamp(main.epoch, tz=timezone.utc) \
        - timedelta(days=min(30.0, days))
    res = api.search(min_mag=min_mag, center=(main.lat, main.lon),
                     radius_km=radius_km, limit=limit, start=start, end=end,
                     with_total=False)
    before, after = [], []
    for q in res.quakes:
        if q.id == main.id:
            continue
        (after if q.epoch > main.epoch else before).append(q)
    return Sequence(main, radius_km, days, before, after,
                    stale=res.stale, min_mag=min_mag)


# --- is this unusual? -----------------------------------------------------

class Activity(object):
    """Recent event counts for an area, against its own longer-run average."""

    def __init__(self, label, min_mag, recent_days, recent, baseline_days,
                 baseline, bands=None):
        self.label = label
        self.min_mag = min_mag
        self.recent_days = recent_days
        self.recent = recent
        self.baseline_days = baseline_days
        self.baseline = baseline
        self.bands = bands or []

    @property
    def expected(self):
        """Events expected in a window of ``recent_days``, from the baseline."""
        if self.baseline is None or not self.baseline_days:
            return None
        return self.baseline * (float(self.recent_days) / self.baseline_days)

    @property
    def ratio(self):
        exp = self.expected
        if not exp or self.recent is None:
            return None
        return self.recent / exp

    def verdict(self):
        ratio = self.ratio
        if ratio is None or self.recent is None:
            return "Not enough history to judge."
        exp = self.expected
        if self.recent < 5 and exp < 5:
            return ("Too few events either way (%d against about %.0f "
                    "expected) to read much into it."
                    % (self.recent, exp))
        if ratio >= 2.5:
            word = "far above"
        elif ratio >= 1.4:
            word = "above"
        elif ratio <= 0.4:
            word = "far below"
        elif ratio <= 0.7:
            word = "below"
        else:
            return ("About normal: %d events against roughly %.0f expected "
                    "over %g days." % (self.recent, exp, self.recent_days))
        return ("%s events, %s the usual %.0f for %g days (%.1fx the "
                "12-month rate)." % (self.recent, word, exp, self.recent_days,
                                     ratio))


def activity(query=None, center=None, radius_km=None, min_mag=2.5,
             recent_days=30.0, baseline_days=365.0, label=None):
    """Compare an area's recent event count with its trailing-year rate.

    Uses the count endpoint, so this is a handful of tiny requests rather
    than downloading any events.
    """
    boxes = [None]
    if center and radius_km:
        name = label or "%.3f, %.3f" % center
        shape = dict(center=center, radius_km=radius_km)
        shapes = [shape]
    elif query:
        hit = regions.resolve(query)
        if not hit:
            raise ValueError("unknown region: %s" % query)
        key, boxes, _ = hit
        name = label or regions.display_name(key)
        shapes = [dict(bbox=b) for b in boxes]
    else:
        name = label or "Worldwide"
        shapes = [{}]

    def total(days):
        got = 0
        for shape in shapes:
            n = api.count(min_mag=min_mag, days=days, **shape)
            if n is None:
                return None
            got += n
        return got

    recent = total(recent_days)
    baseline = total(baseline_days)
    bands = []
    for lo, hi in ((min_mag, 4.0), (4.0, 5.0), (5.0, 6.0), (6.0, None)):
        if hi is not None and hi <= min_mag:
            continue
        n = 0
        for shape in shapes:
            # half-open bands, so an event at exactly 5.0 is counted once
            got = api.count(min_mag=max(lo, min_mag),
                            max_mag=None if hi is None else hi - 0.001,
                            days=recent_days, **shape)
            if got is None:
                n = None
                break
            n += got
        bands.append((max(lo, min_mag), hi, n))
    return Activity(name, min_mag, recent_days, recent, baseline_days,
                    baseline, bands)
