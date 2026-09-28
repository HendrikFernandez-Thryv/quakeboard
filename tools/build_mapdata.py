"""Build eqmon/mapdata.py: a land/sea bitmask baked from Natural Earth data.

Source: world-atlas land-110m (TopoJSON of Natural Earth 1:110m land), which
is public domain. Run only when the mask needs regenerating - the app itself
never downloads this.
"""
import base64, json, sys, zlib

W, H = 720, 360          # 0.5 degrees per cell

topo = json.load(open(sys.argv[1]))
scale, translate = topo["transform"]["scale"], topo["transform"]["translate"]

def decode(arc):
    x = y = 0
    pts = []
    for dx, dy in arc:
        x += dx; y += dy
        pts.append((x * scale[0] + translate[0], y * scale[1] + translate[1]))
    return pts

arcs = [decode(a) for a in topo["arcs"]]

def ring_points(indices):
    pts = []
    for i in indices:
        arc = arcs[~i][::-1] if i < 0 else arcs[i]
        pts.extend(arc if not pts else arc[1:])
    if pts and pts[0] != pts[-1]:
        pts.append(pts[0])       # close it, or even-odd parity leaks
    return pts

polygons = []            # each polygon is a list of rings
for geom in topo["objects"]["land"]["geometries"]:
    if geom["type"] == "Polygon":
        polygons.append([ring_points(r) for r in geom["arcs"]])
    elif geom["type"] == "MultiPolygon":
        for poly in geom["arcs"]:
            polygons.append([ring_points(r) for r in poly])

edges = []               # (lat1, lat2, lon1, lon2)
for rings in polygons:
    for ring in rings:
        for i in range(len(ring) - 1):
            (lon1, lat1), (lon2, lat2) = ring[i], ring[i + 1]
            if lat1 != lat2:
                edges.append((lat1, lat2, lon1, lon2))
print("polygons: %d  edges: %d" % (len(polygons), len(edges)))

grid = bytearray(W * H)
for py in range(H):
    lat = 90.0 - (py + 0.5) * (180.0 / H)
    xs = []
    for lat1, lat2, lon1, lon2 in edges:
        if (lat1 <= lat < lat2) or (lat2 <= lat < lat1):
            xs.append(lon1 + (lat - lat1) * (lon2 - lon1) / (lat2 - lat1))
    xs.sort()
    row = py * W
    for i in range(0, len(xs) - 1, 2):
        a = int((xs[i] + 180.0) * W / 360.0)
        b = int((xs[i + 1] + 180.0) * W / 360.0)
        for px in range(max(0, a), min(W - 1, b) + 1):
            grid[row + px] = 1

packed = bytearray((W * H + 7) // 8)
for i, v in enumerate(grid):
    if v:
        packed[i >> 3] |= 1 << (i & 7)
blob = base64.b64encode(zlib.compress(bytes(packed), 9)).decode()
land = sum(grid)
print("land cells: %d (%.1f%%)  packed: %d B  compressed+b64: %d B"
      % (land, 100.0 * land / (W * H), len(packed), len(blob)))

with open("eqmon/mapdata.py", "w") as fh:
    fh.write('"""Land/sea mask for the world map.\n\n'
             'Generated from world-atlas ``land-110m`` (Natural Earth 1:110m\n'
             'land, public domain) by ``tools/build_mapdata.py``. One bit per\n'
             '0.5 degree cell, row-major from 90N/180W, zlib + base64.\n"""\n\n')
    fh.write("import base64\nimport zlib\n\n")
    fh.write("WIDTH = %d\nHEIGHT = %d\n\n" % (W, H))
    fh.write("_BLOB = (\n")
    for i in range(0, len(blob), 68):
        fh.write('    "%s"\n' % blob[i:i + 68])
    fh.write(")\n\n_MASK = None\n\n\n")
    fh.write('''def mask():
    """The unpacked mask as a bytes object of WIDTH * HEIGHT 0/1 values."""
    global _MASK
    if _MASK is None:
        packed = zlib.decompress(base64.b64decode(_BLOB))
        _MASK = bytes((packed[i >> 3] >> (i & 7)) & 1
                      for i in range(WIDTH * HEIGHT))
    return _MASK


def is_land(lat, lon):
    """True if a coordinate falls on land, at the mask's resolution."""
    if lat is None or lon is None:
        return False
    px = int((lon + 180.0) * WIDTH / 360.0) % WIDTH
    py = int((90.0 - lat) * HEIGHT / 180.0)
    py = max(0, min(HEIGHT - 1, py))
    return bool(mask()[py * WIDTH + px])
''')
print("wrote eqmon/mapdata.py")
