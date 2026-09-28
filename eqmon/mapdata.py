"""Land/sea mask for the world map.

Generated from world-atlas ``land-110m`` (Natural Earth 1:110m
land, public domain) by ``tools/build_mapdata.py``. One bit per
0.5 degree cell, row-major from 90N/180W, zlib + base64.
"""

import base64
import zlib

WIDTH = 720
HEIGHT = 360

_BLOB = (
    "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"
    "Fmz/AWOouWQ="
)

_MASK = None


def mask():
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
