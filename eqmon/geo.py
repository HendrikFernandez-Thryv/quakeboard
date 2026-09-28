"""Distance and bearing helpers."""

import math

EARTH_RADIUS_KM = 6371.0088

COMPASS = ("N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
           "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW")


def haversine(lat1, lon1, lat2, lon2):
    """Great-circle distance in kilometres between two points."""
    if None in (lat1, lon1, lat2, lon2):
        return None
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = p2 - p1
    dl = math.radians(lon2 - lon1)
    a = (math.sin(dp / 2.0) ** 2
         + math.cos(p1) * math.cos(p2) * math.sin(dl / 2.0) ** 2)
    return 2.0 * EARTH_RADIUS_KM * math.asin(min(1.0, math.sqrt(a)))


def bearing(lat1, lon1, lat2, lon2):
    """Initial compass bearing in degrees, 0 = north."""
    if None in (lat1, lon1, lat2, lon2):
        return None
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dl = math.radians(lon2 - lon1)
    y = math.sin(dl) * math.cos(p2)
    x = math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dl)
    return (math.degrees(math.atan2(y, x)) + 360.0) % 360.0


def compass(deg):
    """Bearing in degrees to a 16-point compass name."""
    if deg is None:
        return ""
    return COMPASS[int((deg % 360.0) / 22.5 + 0.5) % 16]


def direction_from(lat1, lon1, lat2, lon2):
    """Compass direction of point 2 as seen from point 1."""
    return compass(bearing(lat1, lon1, lat2, lon2))


def format_km(km):
    if km is None:
        return "?"
    if km < 10:
        return "%.1f km" % km
    if km < 1000:
        return "%d km" % round(km)
    return "{:,} km".format(int(round(km)))


def parse_latlon(text):
    """Parse ``"35.6,139.7"`` into a ``(lat, lon)`` pair."""
    parts = [p.strip() for p in (text or "").replace(";", ",").split(",")]
    if len(parts) != 2:
        raise ValueError("expected 'LAT,LON', got %r" % text)
    try:
        lat, lon = float(parts[0]), float(parts[1])
    except ValueError:
        raise ValueError("expected 'LAT,LON' as numbers, got %r" % text)
    if not (-90.0 <= lat <= 90.0):
        raise ValueError("latitude %g is outside -90..90" % lat)
    if not (-180.0 <= lon <= 180.0):
        raise ValueError("longitude %g is outside -180..180" % lon)
    return lat, lon
