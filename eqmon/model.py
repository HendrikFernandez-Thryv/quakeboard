"""Data model and formatting helpers for earthquake events."""

import time
from datetime import datetime, timezone


class Quake(object):
    """A single seismic event, normalised from a USGS GeoJSON feature."""

    __slots__ = (
        "id", "mag", "mag_type", "place", "time_ms", "updated_ms", "lat", "lon",
        "depth_km", "tsunami", "alert", "status", "felt", "cdi", "mmi", "sig",
        "net", "url", "etype", "title",
    )

    def __init__(self, **kw):
        for name in self.__slots__:
            setattr(self, name, kw.get(name))

    @classmethod
    def from_feature(cls, feat):
        props = feat.get("properties") or {}
        geom = feat.get("geometry") or {}
        coords = geom.get("coordinates") or [None, None, None]
        while len(coords) < 3:
            coords.append(None)
        return cls(
            id=feat.get("id") or "",
            mag=props.get("mag"),
            mag_type=props.get("magType") or "",
            place=props.get("place") or "unknown location",
            time_ms=props.get("time"),
            updated_ms=props.get("updated"),
            lon=coords[0],
            lat=coords[1],
            depth_km=coords[2],
            tsunami=bool(props.get("tsunami")),
            alert=props.get("alert"),
            status=props.get("status") or "",
            felt=props.get("felt"),
            cdi=props.get("cdi"),
            mmi=props.get("mmi"),
            sig=props.get("sig"),
            net=props.get("net") or "",
            url=props.get("url") or "",
            etype=props.get("type") or "earthquake",
            title=props.get("title") or "",
        )

    # -- derived values -------------------------------------------------

    @property
    def magnitude(self):
        """Magnitude as a float, or -99 for events with no magnitude yet."""
        return -99.0 if self.mag is None else float(self.mag)

    @property
    def epoch(self):
        return 0.0 if self.time_ms is None else self.time_ms / 1000.0

    def age_seconds(self, now=None):
        return max(0.0, (now if now is not None else time.time()) - self.epoch)

    def local_time(self):
        if not self.time_ms:
            return "unknown"
        return datetime.fromtimestamp(self.epoch).strftime("%Y-%m-%d %H:%M:%S")

    def utc_time(self):
        if not self.time_ms:
            return "unknown"
        dt = datetime.fromtimestamp(self.epoch, tz=timezone.utc)
        return dt.strftime("%Y-%m-%d %H:%M:%S UTC")

    # -- display --------------------------------------------------------

    def mag_text(self):
        return "  ?" if self.mag is None else "%3.1f" % self.magnitude

    def depth_text(self):
        if self.depth_km is None:
            return "?"
        return "%.1f km" % self.depth_km

    def flags(self):
        out = []
        if self.tsunami:
            out.append("TSU")
        if self.alert:
            out.append(self.alert.upper()[:3])
        if self.felt:
            out.append("felt%d" % self.felt)
        if self.status == "reviewed":
            out.append("rev")
        if self.etype and self.etype != "earthquake":
            out.append(self.etype[:8])
        return " ".join(out)

    def tier(self):
        """Severity bucket used to pick a colour pair."""
        m = self.magnitude
        if m >= 7.0:
            return 4
        if m >= 6.0:
            return 3
        if m >= 5.0:
            return 2
        if m >= 4.0:
            return 1
        return 0


def humanize_span(seconds):
    """A bare duration, for phrases like "3h earlier"."""
    seconds = int(abs(seconds))
    if seconds < 60:
        return "%ds" % seconds
    if seconds < 3600:
        return "%dm" % (seconds // 60)
    if seconds < 172800:
        return "%dh" % (seconds // 3600)
    return "%dd" % (seconds // 86400)


def humanize_age(seconds):
    seconds = int(seconds)
    if seconds < 60:
        return "%ds ago" % seconds
    if seconds < 3600:
        return "%dm ago" % (seconds // 60)
    if seconds < 172800:
        return "%dh ago" % (seconds // 3600)
    return "%dd ago" % (seconds // 86400)
