"""A small gazetteer mapping country and region names to bounding boxes.

Each entry maps a canonical name to one or more boxes of the form
``(min_lat, max_lat, min_lon, max_lon)``. Longitudes may exceed +/-180 to
describe a box that straddles the antimeridian (the FDSN service accepts
that, and :func:`box_contains` normalises accordingly).
"""

import difflib
import unicodedata

# name -> box, or tuple of boxes for territories that are far apart.
BOXES = {
    # --- Americas ---
    "united states": ((24.0, 49.5, -125.0, -66.0), (51.0, 72.0, -170.0, -129.0),
                      (18.5, 22.5, -161.0, -154.5)),
    "alaska": (51.0, 72.0, -170.0, -129.0),
    "california": (32.4, 42.1, -124.5, -114.1),
    "hawaii": (18.5, 22.5, -161.0, -154.5),
    "yellowstone": (43.8, 45.2, -111.3, -109.7),
    "pacific northwest": (41.9, 49.5, -125.5, -116.5),
    "new madrid": (35.0, 38.5, -91.5, -88.0),
    "puerto rico": (17.4, 19.0, -68.0, -65.0),
    "canada": (41.5, 83.5, -141.5, -52.0),
    "mexico": (14.3, 32.8, -118.5, -86.5),
    "guatemala": (13.6, 17.9, -92.3, -88.2),
    "belize": (15.8, 18.6, -89.3, -87.7),
    "el salvador": (12.9, 14.5, -90.2, -87.6),
    "honduras": (12.9, 16.6, -89.4, -83.1),
    "nicaragua": (10.7, 15.1, -87.8, -82.6),
    "costa rica": (8.0, 11.3, -86.0, -82.5),
    "panama": (7.1, 9.7, -83.1, -77.1),
    "central america": (6.0, 18.5, -93.0, -77.0),
    "caribbean": (9.0, 27.0, -86.0, -59.0),
    "cuba": (19.7, 23.3, -85.0, -74.0),
    "haiti": (18.0, 20.1, -74.5, -71.6),
    "dominican republic": (17.5, 20.0, -72.1, -68.3),
    "jamaica": (17.6, 18.6, -78.4, -76.1),
    "trinidad and tobago": (10.0, 11.4, -62.0, -60.4),
    "colombia": (-4.3, 13.5, -79.1, -66.8),
    "venezuela": (0.6, 12.5, -73.4, -59.8),
    "ecuador": (-5.1, 1.5, -81.1, -75.1),
    "galapagos": (-1.6, 0.9, -92.2, -89.0),
    "peru": (-18.4, -0.0, -81.4, -68.6),
    "bolivia": (-23.0, -9.6, -69.7, -57.4),
    "brazil": (-34.0, 5.3, -74.0, -34.7),
    "chile": (-56.0, -17.4, -76.0, -66.3),
    "argentina": (-55.2, -21.7, -73.6, -53.6),
    "uruguay": (-35.1, -30.0, -58.5, -53.1),
    "paraguay": (-27.7, -19.2, -62.7, -54.2),
    "andes": (-56.0, 12.0, -82.0, -62.0),
    "south america": (-56.0, 13.5, -82.0, -34.0),
    "north america": (14.0, 72.0, -170.0, -52.0),

    # --- Europe ---
    "iceland": (63.0, 67.0, -25.0, -13.0),
    "united kingdom": (49.8, 61.0, -8.7, 2.0),
    "ireland": (51.4, 55.5, -10.7, -5.9),
    "norway": (57.9, 71.3, 4.5, 31.2),
    "sweden": (55.3, 69.1, 11.0, 24.2),
    "finland": (59.7, 70.1, 20.5, 31.6),
    "denmark": (54.5, 57.8, 8.0, 15.2),
    "germany": (47.2, 55.1, 5.8, 15.1),
    "netherlands": (50.7, 53.6, 3.3, 7.3),
    "belgium": (49.4, 51.6, 2.5, 6.4),
    "france": (41.3, 51.2, -5.2, 9.6),
    "spain": (35.9, 43.8, -9.4, 3.4),
    "portugal": (36.9, 42.2, -9.6, -6.1),
    "azores": (36.5, 40.0, -31.5, -24.5),
    "canary islands": (27.4, 29.5, -18.3, -13.3),
    "switzerland": (45.8, 47.9, 5.9, 10.5),
    "austria": (46.3, 49.1, 9.5, 17.2),
    "italy": (36.6, 47.1, 6.6, 18.6),
    "sicily": (36.6, 38.4, 12.3, 15.7),
    "etna": (37.4, 38.0, 14.7, 15.3),
    "campi flegrei": (40.7, 41.0, 13.9, 14.3),
    "greece": (34.7, 41.8, 19.3, 28.3),
    "aegean": (34.8, 41.0, 22.5, 28.5),
    "crete": (34.7, 35.8, 23.4, 26.4),
    "turkey": (35.8, 42.2, 25.6, 44.9),
    "cyprus": (34.5, 35.8, 32.2, 34.7),
    "albania": (39.6, 42.7, 19.2, 21.1),
    "north macedonia": (40.8, 42.4, 20.4, 23.1),
    "serbia": (42.2, 46.2, 18.8, 23.1),
    "bosnia and herzegovina": (42.5, 45.3, 15.7, 19.7),
    "croatia": (42.3, 46.6, 13.4, 19.5),
    "slovenia": (45.4, 46.9, 13.3, 16.6),
    "montenegro": (41.8, 43.6, 18.4, 20.4),
    "bulgaria": (41.2, 44.2, 22.3, 28.7),
    "romania": (43.6, 48.3, 20.2, 29.7),
    "vrancea": (45.2, 46.2, 26.0, 27.2),
    "hungary": (45.7, 48.6, 16.1, 22.9),
    "poland": (49.0, 54.9, 14.1, 24.2),
    "czechia": (48.5, 51.1, 12.1, 18.9),
    "slovakia": (47.7, 49.6, 16.8, 22.6),
    "ukraine": (44.3, 52.4, 22.1, 40.2),
    "belarus": (51.2, 56.2, 23.2, 32.8),
    "baltics": (53.9, 59.7, 20.9, 28.2),
    "russia": ((41.2, 82.0, 19.6, 180.0), (41.2, 71.0, -180.0, -169.0)),
    "kamchatka": (50.0, 62.5, 155.0, 168.0),
    "kuril islands": (43.0, 51.0, 145.0, 157.0),
    "georgia country": (41.0, 43.6, 39.9, 46.7),
    "armenia": (38.8, 41.3, 43.4, 46.6),
    "azerbaijan": (38.4, 41.9, 44.8, 50.4),
    "mediterranean": (30.0, 46.0, -6.0, 36.5),
    "balkans": (38.8, 46.6, 13.3, 29.7),
    "europe": (34.5, 71.5, -25.0, 45.0),

    # --- Middle East & Africa ---
    "iran": (25.0, 39.8, 44.0, 63.4),
    "iraq": (29.0, 37.4, 38.8, 48.6),
    "syria": (32.3, 37.3, 35.7, 42.4),
    "lebanon": (33.0, 34.7, 35.1, 36.6),
    "israel": (29.4, 33.3, 34.2, 35.9),
    "jordan": (29.1, 33.4, 34.9, 39.3),
    "saudi arabia": (16.3, 32.2, 34.5, 55.7),
    "yemen": (12.1, 19.0, 42.5, 54.5),
    "oman": (16.6, 26.4, 52.0, 59.9),
    "united arab emirates": (22.6, 26.1, 51.5, 56.4),
    "afghanistan": (29.4, 38.5, 60.5, 74.9),
    "pakistan": (23.7, 37.1, 60.9, 77.1),
    "middle east": (12.0, 40.0, 33.0, 64.0),
    "egypt": (22.0, 31.7, 24.7, 36.9),
    "libya": (19.5, 33.2, 9.3, 25.2),
    "tunisia": (30.2, 37.5, 7.5, 11.6),
    "algeria": (18.9, 37.1, -8.7, 12.0),
    "morocco": (27.6, 35.9, -13.2, -1.0),
    "atlas mountains": (29.0, 35.5, -9.0, 4.0),
    "ethiopia": (3.4, 14.9, 32.9, 48.0),
    "eritrea": (12.4, 18.0, 36.4, 43.2),
    "djibouti": (10.9, 12.8, 41.7, 43.5),
    "somalia": (-1.7, 12.0, 40.9, 51.5),
    "kenya": (-4.7, 5.1, 33.9, 41.9),
    "tanzania": (-11.8, -0.9, 29.3, 40.5),
    "uganda": (-1.5, 4.3, 29.5, 35.1),
    "rwanda": (-2.9, -1.0, 28.8, 30.9),
    "democratic republic of the congo": (-13.5, 5.4, 12.2, 31.3),
    "malawi": (-17.2, -9.3, 32.6, 35.9),
    "mozambique": (-26.9, -10.4, 30.2, 40.9),
    "zambia": (-18.1, -8.2, 21.9, 33.7),
    "zimbabwe": (-22.5, -15.6, 25.2, 33.1),
    "south africa": (-35.0, -22.1, 16.4, 33.0),
    "east african rift": (-15.0, 18.0, 28.0, 45.0),
    "africa": (-35.0, 37.5, -18.0, 52.0),

    # --- Asia ---
    "india": (6.5, 35.7, 68.1, 97.4),
    "nepal": (26.3, 30.5, 80.0, 88.3),
    "bhutan": (26.7, 28.4, 88.7, 92.2),
    "bangladesh": (20.5, 26.7, 88.0, 92.7),
    "sri lanka": (5.9, 9.9, 79.6, 81.9),
    "himalayas": (25.0, 37.0, 70.0, 98.0),
    "china": (18.1, 53.6, 73.5, 135.1),
    "tibet": (27.0, 36.5, 78.0, 99.0),
    "sichuan": (26.0, 34.4, 97.3, 108.6),
    "taiwan": (21.5, 25.5, 119.5, 122.5),
    "mongolia": (41.5, 52.2, 87.7, 119.9),
    "kazakhstan": (40.5, 55.5, 46.5, 87.4),
    "kyrgyzstan": (39.1, 43.3, 69.2, 80.3),
    "tajikistan": (36.6, 41.1, 67.3, 75.2),
    "uzbekistan": (37.1, 45.6, 55.9, 73.2),
    "turkmenistan": (35.1, 42.8, 52.4, 66.7),
    "japan": (24.0, 46.0, 122.0, 146.5),
    "tokyo": (34.9, 36.3, 138.6, 140.6),
    "honshu": (33.4, 41.6, 130.8, 142.1),
    "hokkaido": (41.3, 45.6, 139.3, 146.0),
    "south korea": (33.0, 38.7, 125.9, 129.7),
    "north korea": (37.6, 43.0, 124.2, 130.7),
    "philippines": (4.6, 21.3, 116.9, 126.7),
    "indonesia": (-11.1, 6.1, 94.9, 141.1),
    "java": (-9.1, -5.8, 105.0, 115.0),
    "sumatra": (-6.1, 6.0, 94.9, 106.1),
    "sulawesi": (-6.0, 2.0, 118.0, 125.5),
    "banda sea": (-8.5, -3.0, 123.0, 134.0),
    "malaysia": (0.8, 7.4, 99.6, 119.3),
    "vietnam": (8.2, 23.4, 102.1, 109.5),
    "thailand": (5.6, 20.5, 97.3, 105.7),
    "myanmar": (9.8, 28.6, 92.2, 101.2),
    "laos": (13.9, 22.5, 100.1, 107.7),
    "cambodia": (10.4, 14.7, 102.3, 107.6),
    "southeast asia": (-11.0, 24.0, 92.0, 142.0),
    "asia": (-11.0, 56.0, 26.0, 150.0),

    # --- Oceania & poles ---
    "australia": (-44.0, -10.0, 112.0, 154.0),
    "new zealand": (-48.0, -33.0, 165.0, 180.0),
    "papua new guinea": (-11.7, -0.9, 140.8, 156.0),
    "solomon islands": (-12.3, -5.0, 155.0, 170.3),
    "vanuatu": (-20.3, -13.0, 166.0, 170.3),
    "new caledonia": (-22.8, -19.5, 163.5, 168.2),
    "fiji": (-21.0, -15.5, 176.0, 183.0),
    "tonga": (-23.5, -15.0, 183.0, 188.0),
    "samoa": (-14.5, -13.2, 187.0, 190.5),
    "guam": (13.0, 13.8, 144.5, 145.1),
    "mariana islands": (12.5, 21.0, 143.5, 147.0),
    "oceania": (-48.0, 21.0, 112.0, 190.0),
    "antarctica": (-90.0, -60.0, -180.0, 180.0),
    "arctic": (66.0, 90.0, -180.0, 180.0),
    "mid atlantic ridge": (-55.0, 70.0, -45.0, -5.0),
    "ring of fire": ((-60.0, 66.0, 120.0, 180.0), (-60.0, 66.0, -180.0, -60.0)),
    "world": (-90.0, 90.0, -180.0, 180.0),
    "global": (-90.0, 90.0, -180.0, 180.0),
}

# Common alternates, demonyms and abbreviations.
ALIASES = {
    "usa": "united states", "us": "united states", "u.s.": "united states",
    "u.s.a.": "united states", "america": "united states",
    "united states of america": "united states", "american": "united states",
    "ca": "california", "socal": "california", "norcal": "california",
    "cascadia": "pacific northwest", "uk": "united kingdom",
    "britain": "united kingdom", "great britain": "united kingdom",
    "england": "united kingdom", "scotland": "united kingdom",
    "wales": "united kingdom", "holland": "netherlands",
    "deutschland": "germany", "german": "germany", "french": "france",
    "italian": "italy", "spanish": "spain", "espana": "spain",
    "greek": "greece", "hellas": "greece", "turkiye": "turkey",
    "turkish": "turkey", "anatolia": "turkey", "istanbul": "turkey",
    "czech republic": "czechia", "macedonia": "north macedonia",
    "bosnia": "bosnia and herzegovina", "herzegovina": "bosnia and herzegovina",
    "russian federation": "russia", "russian": "russia", "siberia": "russia",
    "kurils": "kuril islands", "kurile islands": "kuril islands",
    "georgia": "georgia country", "republic of georgia": "georgia country",
    "uae": "united arab emirates", "emirates": "united arab emirates",
    "persia": "iran", "iranian": "iran", "drc": "democratic republic of the congo",
    "congo": "democratic republic of the congo", "japanese": "japan",
    "nippon": "japan", "korea": "south korea", "republic of korea": "south korea",
    "dprk": "north korea", "prc": "china", "chinese": "china",
    "formosa": "taiwan", "indonesian": "indonesia", "bali": "java",
    "borneo": "malaysia", "burma": "myanmar", "siam": "thailand",
    "nz": "new zealand", "aotearoa": "new zealand", "kiwi": "new zealand",
    "png": "papua new guinea", "aussie": "australia", "oz": "australia",
    "pacific": "ring of fire", "pacific ring of fire": "ring of fire",
    "everywhere": "world", "worldwide": "world", "all": "world",
    "mid-atlantic ridge": "mid atlantic ridge", "atlantic": "mid atlantic ridge",
    "puerto-rico": "puerto rico", "dr": "dominican republic",
    "himalaya": "himalayas", "rift valley": "east african rift",
    "east africa": "east african rift", "med": "mediterranean",
    "mount etna": "etna", "vesuvius": "italy", "iceland region": "iceland",
}

# Pretty display names for entries whose key is disambiguated or lowercase-odd.
DISPLAY = {
    "georgia country": "Georgia (country)",
    "united arab emirates": "United Arab Emirates",
    "democratic republic of the congo": "DR Congo",
    "mid atlantic ridge": "Mid-Atlantic Ridge",
    "ring of fire": "Pacific Ring of Fire",
    "east african rift": "East African Rift",
    "new madrid": "New Madrid Seismic Zone",
    "campi flegrei": "Campi Flegrei",
    "world": "Worldwide",
    "global": "Worldwide",
}


def display_name(key):
    if key in DISPLAY:
        return DISPLAY[key]
    return " ".join(w.capitalize() for w in key.split())


def normalize(text):
    """Lowercase, strip accents and collapse punctuation to spaces."""
    text = unicodedata.normalize("NFKD", (text or "").strip().lower())
    text = "".join(c for c in text if not unicodedata.combining(c))
    kept = [c if (c.isalnum() or c == ".") else " " for c in text]
    return " ".join("".join(kept).split())


def boxes_for(key):
    """Return a list of boxes for a canonical key."""
    value = BOXES[key]
    if value and isinstance(value[0], tuple):
        return list(value)
    return [value]


def resolve(query):
    """Resolve free text to ``(canonical_key, [boxes], how)``, or ``None``.

    ``how`` records the confidence of the match - "exact", "partial" or
    "guess" - so callers can tell the user when the query was interpreted
    loosely rather than matched outright.
    """
    q = normalize(query)
    if not q:
        return None
    if q in ALIASES:
        q = ALIASES[q]
    if q in BOXES:
        return q, boxes_for(q), "exact"

    names = list(BOXES) + list(ALIASES)
    starts = sorted((n for n in names if n.startswith(q)), key=len)
    if starts:
        key = ALIASES.get(starts[0], starts[0])
        return key, boxes_for(key), "exact" if len(q) > 3 else "partial"

    contains = sorted((n for n in names if q in n or n in q), key=len)
    if contains:
        key = ALIASES.get(contains[0], contains[0])
        return key, boxes_for(key), "partial"

    close = difflib.get_close_matches(q, names, n=1, cutoff=0.78)
    if close:
        key = ALIASES.get(close[0], close[0])
        return key, boxes_for(key), "guess"
    return None


def suggest(query, limit=6):
    """Names to offer the user when a query does not resolve."""
    q = normalize(query)
    names = sorted(BOXES)
    if not q:
        return names[:limit]
    hits = [n for n in names if q in n]
    for n in difflib.get_close_matches(q, names + list(ALIASES), n=limit, cutoff=0.5):
        n = ALIASES.get(n, n)
        if n not in hits:
            hits.append(n)
    return hits[:limit]


def box_contains(box, lat, lon):
    """True if ``(lat, lon)`` falls inside a box, honouring wrapped longitudes."""
    if lat is None or lon is None:
        return False
    min_lat, max_lat, min_lon, max_lon = box
    if not (min_lat <= lat <= max_lat):
        return False
    if max_lon > 180.0:  # box crosses the antimeridian
        lon = lon + 360.0 if lon < min_lon - 180.0 else lon
    if min_lon < -180.0:
        lon = lon - 360.0 if lon > max_lon + 180.0 else lon
    return min_lon <= lon <= max_lon
