#!/usr/bin/env python3
"""Write web/test/fixtures.json: what the terminal app computes, so the web
app's JavaScript port can be checked against it.

    python3 tools/gen_web_fixtures.py

Re-run this if eqmon's region matching or analysis wording changes, then run
``node --test web/test/*.test.js`` to see where the two disagree.
"""

import difflib
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from eqmon import geo, model, regions, service  # noqa: E402

NOW = 1800000000.0
DAY = 86400.0

QUERIES = [
    "japan", "Japan", "  JAPAN ", "chile", "united states", "usa", "US", "u.s.",
    "uk", "nz", "new zealand", "NZ", "türkiye", "Turkey", "turkiye", "persia",
    "burma", "myanmar", "philippines", "philipines", "philipnes", "chili",
    "chille", "indonesa", "grece", "italy", "itly", "jap", "aege", "philip",
    "indo", "new z", "united", "south", "north", "mid", "ring of fire",
    "pacific", "mediterranean", "himalayas", "east african rift", "world",
    "everywhere", "tonga", "fiji", "alaska", "california", "hawaii", "iceland",
    "kamchatka", "sumatra", "java", "bali", "taiwan", "nepal", "peru",
    "ecuador", "greece", "mexico city", "japan earthquake", "chile quake",
    "atlantis", "narnia", "qwertyuiop", "zzz", "", "   ", "georgia",
    "republic of georgia", "korea", "south korea", "dprk", "drc", "congo",
    "uae", "png", "cascadia", "socal", "new madrid", "yellowstone", "etna",
    "kuril", "kurils", "baltics", "balkans", "andes", "arctic", "antarctica",
]

NORMALIZE = [
    "Japan", "  Türkiye ", "São Tomé", "Côte d'Ivoire", "U.S.A.", "New-Zealand",
    "mid-atlantic ridge", "  a   b  ", "Ελλάδα", "Zürich!", "x.y", "", "  ",
    "Ring  of   Fire", "Łódź",
]

RATIO = [("japan", "japn"), ("chile", "chili"), ("greece", "grece"),
         ("atlantic", "atlantis"), ("aegean", "aege"), ("", ""), ("a", "a"),
         ("abcd", "dcba"), ("new zealand", "new zeland"), ("tonga", "tongo"),
         ("philippines", "philipines"), ("kermadec", "kermadek")]

POINTS = [(35.68, 139.77, 34.05, -118.24), (0, 0, 0, 0), (0, 0, 10, 0),
          (0, 0, 0, 10), (51.5, -0.12, 48.85, 2.35), (-33.9, 151.2, -41.3, 174.8),
          (89, 0, -89, 180), (10, 179, 10, -179), (35.0, 139.0, 35.7, 139.7)]

MAGS = [-1, 0, 2, 3.5, 4, 5, 5.5, 6, 6.5, 7, 7.5, 8, 9, 9.5]
KMS = [0.04, 3.14, 9.99, 10.4, 99.5, 842.3, 999.4, 1001.0, 12345.6]
DEGS = [0, 11, 22.4, 22.6, 45, 90, 135, 180, 225, 270, 315, 337.4, 337.6, 359.9]


def quake(eid, mag, offset, lat=10.0, lon=20.0, place="p"):
    return {"id": eid, "mag": mag, "t": offset, "lat": lat, "lon": lon,
            "place": place}


def build(ev):
    return model.Quake.from_feature({
        "id": ev["id"],
        "properties": {"mag": ev["mag"], "place": ev["place"],
                       "time": (NOW + ev["t"]) * 1000.0},
        "geometry": {"coordinates": [ev["lon"], ev["lat"], 10.0]}})


def scenario(name, main_mag, main_offset, before, after):
    main = quake("main", main_mag, main_offset)
    fore = [quake("b%d" % i, m, main_offset - dt) for i, (m, dt) in enumerate(before)]
    aft = [quake("a%d" % i, m, main_offset + dt) for i, (m, dt) in enumerate(after)]
    seq = service.Sequence(build(main), 50.0, 30.0, [build(e) for e in fore],
                           [build(e) for e in aft], min_mag=3.0)
    return {
        "name": name, "main": main, "before": fore, "after": aft,
        "verdict": seq.verdict(), "bath": seq.bath_gap(),
        "counts": seq.counts_by_day(5), "first": seq.rate_first_day,
        "last": seq.rate_last_day, "elapsed": seq.elapsed_days,
        "largest": seq.largest.magnitude if seq.largest else None,
    }


def main():
    service.time.time = lambda: NOW          # make "now" deterministic

    out = {"now": NOW}
    out["resolve"] = []
    for q in QUERIES:
        hit = regions.resolve(q)
        out["resolve"].append([q, hit[0] if hit else None,
                               hit[2] if hit else None])
    out["normalize"] = [[s, regions.normalize(s)] for s in NORMALIZE]
    out["ratio"] = [[a, b, difflib.SequenceMatcher(None, a, b).ratio()]
                    for a, b in RATIO]
    out["closeMatches"] = [
        [w, difflib.get_close_matches(w, list(regions.BOXES) + list(regions.ALIASES), n=3, cutoff=0.6)]
        for w in ("japn", "chili", "atlantis", "kermadek", "zealand", "greec")]
    out["display"] = [[k, regions.display_name(k)] for k in
                      ("japan", "new zealand", "ring of fire", "georgia country",
                       "democratic republic of the congo", "east african rift")]
    out["haversine"] = [list(p) + [geo.haversine(*p)] for p in POINTS]
    out["bearing"] = [list(p) + [geo.bearing(*p)] for p in POINTS]
    out["compass"] = [[d, geo.compass(d)] for d in DEGS]
    out["formatKm"] = [[k, geo.format_km(k)] for k in KMS]
    out["radius"] = [[m, service.aftershock_radius_km(m)] for m in MAGS]
    out["boxContains"] = [
        [list(regions.boxes_for(n)[0]), lat, lon, regions.box_contains(regions.boxes_for(n)[0], lat, lon)]
        for n, lat, lon in (("japan", 35.7, 139.7), ("japan", 35.7, -120.0),
                            ("tonga", -18.0, -174.0), ("tonga", -18.0, 100.0),
                            ("fiji", -17.0, 178.0), ("fiji", -17.0, -178.0),
                            ("new zealand", -41.0, 174.0), ("new zealand", -41.0, -175.0))]

    hour, day = 3600.0, DAY
    out["sequences"] = [
        scenario("empty", 6.0, -5 * day, [], []),
        scenario("empty, bigger foreshock", 5.0, -5 * day, [(6.2, 2 * hour)], []),
        scenario("first 24 hours", 6.5, -6 * hour, [], [(5.0, hour), (4.1, 2 * hour)]),
        scenario("decaying", 6.5, -4 * day,
                 [], [(5.3, hour * k) for k in range(1, 15)] + [(4.0, 3 * day + hour)]),
        scenario("quiet for a day", 6.0, -3 * day, [], [(4.5, hour), (4.0, 5 * hour)]),
        scenario("steady", 6.0, -3 * day, [],
                 [(4.0, hour * k) for k in (1, 2, 3)] + [(4.0, 2 * day + hour * k) for k in (8, 9, 10)] ),
        scenario("accelerating", 6.0, -3 * day, [],
                 [(4.0, hour)] + [(4.0, 2 * day + hour * k) for k in (1, 2, 3, 4, 5, 6)]),
        scenario("small gap", 6.0, -3 * day, [], [(5.8, hour), (4.0, 2 * day + 5 * hour)]),
        scenario("gap 0.4", 6.0, -3 * day, [], [(5.6, hour), (4.0, 2 * day + 5 * hour)]),
        scenario("gap 0.6", 6.0, -3 * day, [], [(5.4, hour), (4.0, 2 * day + 5 * hour)]),
        scenario("later one was larger", 5.0, -3 * day, [], [(5.6, hour), (4.0, 2 * day + 5 * hour)]),
        scenario("foreshock and aftershocks", 5.0, -3 * day, [(6.0, hour)],
                 [(4.0, hour), (4.0, 2 * day + 5 * hour)]),
    ]

    acts = []
    for label, recent, baseline in (("a", 100, 365), ("b", 300, 365), ("c", 30, 365),
                                    ("d", 6, 365), ("e", 2, 24), ("f", 10, None),
                                    ("g", 50, 1372), ("h", 9, 240), ("i", 0, 0)):
        a = service.Activity(label, 2.5, 30.0, recent, 365.0, baseline)
        acts.append({"label": label, "recent": recent, "baseline": baseline,
                     "expected": a.expected, "ratio": a.ratio,
                     "verdict": a.verdict()})
    out["activities"] = acts

    path = os.path.join(ROOT, "web", "test", "fixtures.json")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(out, fh, ensure_ascii=False, indent=1)
    print("wrote %s: %d resolve, %d sequences, %d activities"
          % (os.path.relpath(path, ROOT), len(out["resolve"]),
             len(out["sequences"]), len(acts)))


if __name__ == "__main__":
    main()
