"""An ASCII/braille world map.

Land comes from the baked mask in :mod:`eqmon.mapdata`. Each character cell
holds a 2x4 grid of braille dots, so a 100x24 pane is a 200x96 pixel canvas -
enough to recognise the continents and see where a sequence is clustered.

Events are drawn as single characters that replace the braille cell, because
a terminal can only colour a whole cell: a coloured marker reads far better
than a dot lost in a coastline.
"""

from . import mapdata

# Braille dot bit for each (column, row) inside a cell.
DOTS = {(0, 0): 0x01, (0, 1): 0x02, (0, 2): 0x04, (0, 3): 0x40,
        (1, 0): 0x08, (1, 1): 0x10, (1, 2): 0x20, (1, 3): 0x80}
BRAILLE_BASE = 0x2800

WORLD = (-60.0, 84.0, -180.0, 180.0)   # trims empty polar rows

# Marker per magnitude tier, from :meth:`eqmon.model.Quake.tier`.
MARKERS = (".", "o", "O", "@", "@")
HOME_MARKER = "+"

_cache = {}


def _bounds(bounds=None, pad=True):
    if not bounds:
        return WORLD
    min_lat, max_lat, min_lon, max_lon = bounds
    if pad:
        dlat, dlon = (max_lat - min_lat) * 0.08, (max_lon - min_lon) * 0.08
        min_lat, max_lat = max(-90.0, min_lat - dlat), min(90.0, max_lat + dlat)
        min_lon, max_lon = min_lon - dlon, max_lon + dlon
    if max_lat - min_lat < 1.0:
        mid = (max_lat + min_lat) / 2.0
        min_lat, max_lat = mid - 0.5, mid + 0.5
    if max_lon - min_lon < 1.0:
        mid = (max_lon + min_lon) / 2.0
        min_lon, max_lon = mid - 0.5, mid + 0.5
    return min_lat, max_lat, min_lon, max_lon


def project(bounds, width, height, lat, lon):
    """Coordinate to ``(row, col)`` in a ``width`` x ``height`` grid of cells.

    Returns ``None`` when the point falls outside the view.
    """
    if lat is None or lon is None:
        return None
    min_lat, max_lat, min_lon, max_lon = bounds
    while lon < min_lon:
        lon += 360.0
    while lon > max_lon and lon - 360.0 >= min_lon:
        lon -= 360.0
    if not (min_lat <= lat <= max_lat and min_lon <= lon <= max_lon):
        return None
    col = int((lon - min_lon) / (max_lon - min_lon) * width)
    row = int((max_lat - lat) / (max_lat - min_lat) * height)
    return max(0, min(height - 1, row)), max(0, min(width - 1, col))


def land_rows(bounds, width, height, ascii_only=False, outline=True):
    """Render the land mask as ``height`` strings of ``width`` characters.

    ``outline`` draws coastlines only, which keeps the interior clear for
    event markers; the filled form is available for a solid silhouette.
    """
    key = (bounds, width, height, ascii_only, outline)
    if key in _cache:
        return _cache[key]
    min_lat, max_lat, min_lon, max_lon = bounds
    dot_w, dot_h = width * 2, height * 4
    dlon = (max_lon - min_lon) / dot_w
    dlat = (max_lat - min_lat) / dot_h

    # Sample every source cell a dot covers, so thin coasts survive.
    steps_x = max(1, int(dlon / (360.0 / mapdata.WIDTH)))
    steps_y = max(1, int(dlat / (180.0 / mapdata.HEIGHT)))
    mask, mw, mh = mapdata.mask(), mapdata.WIDTH, mapdata.HEIGHT

    # Count how much of each dot's footprint is land and take the majority.
    # "Any land" would inflate the continents badly at these scales.
    hits = [0] * (dot_w * dot_h)
    samples = steps_x * steps_y
    for dy in range(dot_h):
        top = max_lat - dy * dlat
        row = dy * dot_w
        for sy in range(steps_y):
            lat = top - (sy + 0.5) * dlat / steps_y
            py = int((90.0 - lat) * mh / 180.0)
            if not (0 <= py < mh):
                continue
            base = py * mw
            for dx in range(dot_w):
                left = min_lon + dx * dlon
                for sx in range(steps_x):
                    lon = left + (sx + 0.5) * dlon / steps_x
                    px = int((lon + 180.0) * mw / 360.0) % mw
                    if mask[base + px]:
                        hits[row + dx] += 1
    cutoff = max(1, (samples + 1) // 2)
    dots = bytearray(1 if h >= cutoff else 0 for h in hits)

    if outline:
        # Keep only land dots that touch water, so we get coastlines.
        wrap = (max_lon - min_lon) >= 359.0
        edge = bytearray(dot_w * dot_h)
        for dy in range(dot_h):
            row = dy * dot_w
            up = row - dot_w if dy > 0 else None
            down = row + dot_w if dy + 1 < dot_h else None
            for dx in range(dot_w):
                if not dots[row + dx]:
                    continue
                left = dx - 1
                right = dx + 1
                if left < 0:
                    left = dot_w - 1 if wrap else None
                if right >= dot_w:
                    right = 0 if wrap else None
                for n in (up + dx if up is not None else None,
                          down + dx if down is not None else None,
                          row + left if left is not None else None,
                          row + right if right is not None else None):
                    if n is None or not dots[n]:
                        edge[row + dx] = 1
                        break
        dots = edge

    rows = []
    for cy in range(height):
        chars = []
        for cx in range(width):
            if ascii_only:
                hit = any(dots[(cy * 4 + ry) * dot_w + cx * 2 + rx]
                          for ry in range(4) for rx in range(2))
                chars.append("#" if hit else " ")
                continue
            bits = 0
            for (rx, ry), bit in DOTS.items():
                if dots[(cy * 4 + ry) * dot_w + cx * 2 + rx]:
                    bits |= bit
            chars.append(chr(BRAILLE_BASE + bits))
        rows.append("".join(chars))
    if len(_cache) > 8:
        _cache.clear()
    _cache[key] = rows
    return rows


class Rendered(object):
    def __init__(self, rows, markers, bounds, plotted, offscreen):
        self.rows = rows              # land, as strings
        self.markers = markers        # [(row, col, char, tier, quake)]
        self.bounds = bounds
        self.plotted = plotted
        self.offscreen = offscreen


def render(quakes, width, height, bounds=None, home=None, selected=None,
           ascii_only=False, outline=True):
    """Land plus event markers, ready to paint.

    Markers are ordered weakest first so the strongest event wins a shared
    cell, and the selected event wins outright.
    """
    view = _bounds(bounds)
    rows = land_rows(view, width, height, ascii_only, outline)
    cells = {}
    offscreen = 0
    for q in sorted(quakes, key=lambda q: q.magnitude):
        spot = project(view, width, height, q.lat, q.lon)
        if spot is None:
            offscreen += 1
            continue
        cells[spot] = (MARKERS[q.tier()], q.tier(), q)
    if home:
        spot = project(view, width, height, home[0], home[1])
        if spot is not None and spot not in cells:
            cells[spot] = (HOME_MARKER, -1, None)
    if selected is not None:
        spot = project(view, width, height, selected.lat, selected.lon)
        if spot is not None:
            cells[spot] = (MARKERS[selected.tier()], selected.tier(), selected)
    markers = [(r, c, ch, tier, q) for (r, c), (ch, tier, q) in cells.items()]
    return Rendered(rows, markers, view, len(cells), offscreen)


def to_text(rendered):
    """Flatten a render into plain strings, markers included."""
    grid = [list(r) for r in rendered.rows]
    for row, col, char, _tier, _q in rendered.markers:
        if 0 <= row < len(grid) and 0 <= col < len(grid[row]):
            grid[row][col] = char
    return ["".join(r).rstrip() for r in grid]
