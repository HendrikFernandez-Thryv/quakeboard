"""Offline tests: run with `python3 test_quakeboard.py`.

Nothing here touches the network. Pass --net to also exercise the live USGS
service: `python3 test_quakeboard.py --net`.
"""

import io
import os
import shutil
import sys
import tempfile
import time
import unittest

# Redirect the cache and config to throwaway directories before the modules
# that read them are imported.
_TMP = tempfile.mkdtemp(prefix="quakeboard-test-")
os.environ["XDG_CACHE_HOME"] = os.path.join(_TMP, "cache")
os.environ["XDG_CONFIG_HOME"] = os.path.join(_TMP, "config")

from eqmon import (cache, config, geo, map as worldmap, mapdata, model,
                   plain, regions, service, ui, watch)

FEATURE = {
    "id": "us7000abcd",
    "properties": {
        "mag": 6.4, "magType": "mww", "place": "88 km NNW of Uken, Japan",
        "time": 1700000000000, "updated": 1700000100000, "tsunami": 1,
        "alert": "yellow", "felt": 12, "cdi": 4.6, "mmi": 5.1, "sig": 640,
        "status": "reviewed", "net": "us", "type": "earthquake",
        "url": "https://example.test/event", "title": "M 6.4 - Japan",
    },
    "geometry": {"coordinates": [128.5, 28.9, 35.7]},
}


def quake(mag=5.0, lat=0.0, lon=0.0, when=None, place="somewhere", eid=None,
          depth=10.0):
    """Build a Quake without going near the network."""
    when = time.time() if when is None else when
    return model.Quake.from_feature({
        "id": eid or ("id%s" % when),
        "properties": {"mag": mag, "place": place, "time": when * 1000.0,
                       "magType": "mb", "status": "reviewed"},
        "geometry": {"coordinates": [lon, lat, depth]},
    })


class TestModel(unittest.TestCase):
    def setUp(self):
        self.q = model.Quake.from_feature(FEATURE)

    def test_fields(self):
        self.assertEqual(self.q.id, "us7000abcd")
        self.assertAlmostEqual(self.q.magnitude, 6.4)
        self.assertAlmostEqual(self.q.lat, 28.9)
        self.assertAlmostEqual(self.q.lon, 128.5)
        self.assertAlmostEqual(self.q.depth_km, 35.7)
        self.assertTrue(self.q.tsunami)

    def test_missing_magnitude_prints_safely(self):
        q = model.Quake.from_feature({"id": "x",
                                      "properties": {"place": "nowhere"},
                                      "geometry": {}})
        self.assertEqual(q.mag_text().strip(), "?")
        self.assertEqual(q.depth_text(), "?")
        self.assertEqual(q.tier(), 0)
        self.assertEqual(q.local_time(), "unknown")

    def test_display_helpers(self):
        self.assertEqual(self.q.mag_text(), "6.4")
        self.assertEqual(self.q.depth_text(), "35.7 km")
        self.assertEqual(self.q.tier(), 3)
        self.assertIn("TSU", self.q.flags())
        self.assertIn("YEL", self.q.flags())

    def test_tier_boundaries(self):
        self.assertEqual([quake(mag=m).tier()
                          for m in (3.9, 4.0, 5.0, 6.0, 7.0, 9.1)],
                         [0, 1, 2, 3, 4, 4])

    def test_humanize(self):
        self.assertEqual(model.humanize_age(5), "5s ago")
        self.assertEqual(model.humanize_age(125), "2m ago")
        self.assertEqual(model.humanize_age(400000), "4d ago")
        self.assertEqual(model.humanize_span(125), "2m")
        self.assertEqual(model.humanize_span(-7200), "2h")

    def test_age_never_negative(self):
        self.assertEqual(quake(when=time.time() + 600).age_seconds(), 0.0)


class TestGeo(unittest.TestCase):
    def test_known_distances(self):
        # Tokyo to Los Angeles is about 8,800 km.
        km = geo.haversine(35.68, 139.77, 34.05, -118.24)
        self.assertTrue(8700 < km < 8900, km)
        self.assertEqual(geo.haversine(0, 0, 0, 0), 0.0)
        self.assertIsNone(geo.haversine(None, 0, 1, 1))

    def test_bearing_and_compass(self):
        self.assertAlmostEqual(geo.bearing(0, 0, 10, 0), 0.0, places=5)
        self.assertAlmostEqual(geo.bearing(0, 0, 0, 10), 90.0, places=5)
        self.assertEqual(geo.compass(0), "N")
        self.assertEqual(geo.compass(90), "E")
        self.assertEqual(geo.compass(315), "NW")
        self.assertEqual(geo.compass(359), "N")
        self.assertEqual(geo.compass(None), "")

    def test_format_km(self):
        self.assertEqual(geo.format_km(5.25), "5.2 km")
        self.assertEqual(geo.format_km(842.3), "842 km")
        self.assertEqual(geo.format_km(12345.6), "12,346 km")
        self.assertEqual(geo.format_km(None), "?")

    def test_parse_latlon(self):
        self.assertEqual(geo.parse_latlon(" 35.68 , 139.77 "), (35.68, 139.77))
        self.assertEqual(geo.parse_latlon("-1;-2"), (-1.0, -2.0))
        for bad in ("", "1", "a,b", "91,0", "0,181", "1,2,3"):
            self.assertRaises(ValueError, geo.parse_latlon, bad)


class TestRegions(unittest.TestCase):
    def test_exact_and_alias(self):
        self.assertEqual(regions.resolve("Japan")[0], "japan")
        self.assertEqual(regions.resolve("usa")[0], "united states")
        self.assertEqual(regions.resolve("  TÜRKIYE ")[0], "turkey")
        self.assertEqual(regions.resolve("Japan")[2], "exact")

    def test_misspelling_is_flagged_as_a_guess(self):
        key, _, how = regions.resolve("chili")
        self.assertEqual((key, how), ("chile", "guess"))

    def test_unknown_place(self):
        self.assertIsNone(regions.resolve("qwertyuiop"))
        self.assertIsNone(regions.resolve("   "))

    def test_multi_box_countries(self):
        self.assertGreater(len(regions.resolve("united states")[1]), 1)

    def test_box_contains(self):
        tokyo = regions.boxes_for("japan")[0]
        self.assertTrue(regions.box_contains(tokyo, 35.7, 139.7))
        self.assertFalse(regions.box_contains(tokyo, 35.7, -120.0))
        self.assertFalse(regions.box_contains(tokyo, None, None))

    def test_antimeridian_box(self):
        tonga = regions.boxes_for("tonga")[0]
        self.assertTrue(regions.box_contains(tonga, -18.0, -174.0))
        self.assertFalse(regions.box_contains(tonga, -18.0, 100.0))

    def test_every_box_is_sane(self):
        for name in regions.BOXES:
            for lo_lat, hi_lat, lo_lon, hi_lon in regions.boxes_for(name):
                self.assertLess(lo_lat, hi_lat, name)
                self.assertLess(lo_lon, hi_lon, name)
                self.assertGreaterEqual(lo_lat, -90.0, name)
                self.assertLessEqual(hi_lat, 90.0, name)

    def test_aliases_point_at_real_entries(self):
        for alias, target in regions.ALIASES.items():
            self.assertIn(target, regions.BOXES, alias)


class TestCache(unittest.TestCase):
    def setUp(self):
        cache.clear()

    def test_round_trip(self):
        cache.store("http://x/1", "body", etag='"e"', modified="then")
        entry = cache.load("http://x/1")
        self.assertEqual(entry["body"], "body")
        self.assertEqual(entry["etag"], '"e"')
        self.assertLess(cache.age(entry), 5)

    def test_missing_and_corrupt(self):
        self.assertIsNone(cache.load("http://x/nope"))
        path = os.path.join(cache.cache_dir(), "junk.json")
        os.makedirs(cache.cache_dir(), exist_ok=True)
        with open(path, "w") as fh:
            fh.write("{not json")
        self.assertIsNone(cache.load("http://x/whatever"))

    def test_touch_refreshes(self):
        cache.store("http://x/2", "b", etag='"e"')
        entry = cache.load("http://x/2")
        entry["fetched"] = 0
        cache.touch("http://x/2", entry)
        self.assertLess(cache.age(cache.load("http://x/2")), 5)

    def test_clear_and_stats(self):
        cache.store("http://x/3", "b")
        self.assertEqual(cache.stats()[0], 1)
        self.assertEqual(cache.clear(), 1)
        self.assertEqual(cache.stats()[0], 0)


class TestConfig(unittest.TestCase):
    def setUp(self):
        try:
            os.unlink(config.config_path())
        except OSError:
            pass

    def test_defaults_when_absent(self):
        s = config.load()
        self.assertEqual(s["min_mag"], 4.0)
        self.assertEqual(s["bookmarks"], [])
        self.assertIsNone(s["home"])

    def test_corrupt_file_falls_back(self):
        os.makedirs(config.config_dir(), exist_ok=True)
        with open(config.config_path(), "w") as fh:
            fh.write("{not json")
        self.assertEqual(config.load()["min_mag"], 4.0)

    def test_save_and_reload(self):
        s = config.load()
        config.add_bookmark(s, "japan", 4.0, 30)
        config.set_home(s, 32.78, -96.80, "Dallas")
        self.assertTrue(config.save(s))
        back = config.load()
        self.assertEqual(back["bookmarks"][0]["query"], "japan")
        self.assertEqual(back["home"]["name"], "Dallas")

    def test_bookmarks_dedupe_and_cap(self):
        s = config.load()
        for i in range(config.MAX_BOOKMARKS + 5):
            config.add_bookmark(s, "place%d" % i)
        self.assertEqual(len(s["bookmarks"]), config.MAX_BOOKMARKS)
        config.add_bookmark(s, "japan")
        config.add_bookmark(s, "JAPAN")
        queries = [b["query"].lower() for b in s["bookmarks"]]
        self.assertEqual(queries.count("japan"), 1)

    def test_remove_bookmark_bounds(self):
        s = config.load()
        config.add_bookmark(s, "japan")
        self.assertIsNone(config.remove_bookmark(s, 0))
        self.assertIsNone(config.remove_bookmark(s, 9))
        self.assertEqual(config.remove_bookmark(s, 1)["query"], "japan")

    def test_bad_home_is_dropped(self):
        os.makedirs(config.config_dir(), exist_ok=True)
        with open(config.config_path(), "w") as fh:
            fh.write('{"home": {"lat": 200, "lon": 0}}')
        self.assertIsNone(config.load()["home"])

    def test_string_bookmarks_are_upgraded(self):
        os.makedirs(config.config_dir(), exist_ok=True)
        with open(config.config_path(), "w") as fh:
            fh.write('{"bookmarks": ["japan", {"query": "chile"}, 7]}')
        marks = config.load()["bookmarks"]
        self.assertEqual([m["query"] for m in marks], ["japan", "chile"])


class TestMap(unittest.TestCase):
    def test_mask_dimensions(self):
        self.assertEqual(len(mapdata.mask()),
                         mapdata.WIDTH * mapdata.HEIGHT)

    def test_known_land_and_sea(self):
        for lat, lon, expected in ((48.85, 2.35, True),      # Paris
                                   (35.70, 139.70, True),    # Tokyo
                                   (-3.0, -60.0, True),      # Amazon
                                   (30.0, -40.0, False),     # mid-Atlantic
                                   (0.0, -150.0, False),     # Pacific
                                   (82.0, -120.0, False)):   # Arctic Ocean
            self.assertEqual(mapdata.is_land(lat, lon), expected,
                             "%s, %s" % (lat, lon))
        self.assertFalse(mapdata.is_land(None, None))

    def test_projection(self):
        bounds = (-60.0, 84.0, -180.0, 180.0)
        row, col = worldmap.project(bounds, 100, 20, 84.0, -180.0)
        self.assertEqual((row, col), (0, 0))
        self.assertIsNone(worldmap.project(bounds, 100, 20, -80.0, 0.0))
        self.assertIsNone(worldmap.project(bounds, 100, 20, None, None))

    def test_projection_wraps_longitude(self):
        bounds = (-25.0, -8.0, 160.0, 200.0)      # crosses the antimeridian
        self.assertIsNotNone(worldmap.project(bounds, 80, 20, -18.0, -174.0))
        self.assertIsNotNone(worldmap.project(bounds, 80, 20, -18.0, 170.0))
        self.assertIsNone(worldmap.project(bounds, 80, 20, -18.0, 0.0))

    def test_render_shapes(self):
        shot = worldmap.render([quake(lat=0, lon=0)], 40, 8)
        self.assertEqual(len(shot.rows), 8)
        self.assertTrue(all(len(r) == 40 for r in shot.rows))
        self.assertEqual(shot.plotted, 1)

    def test_bigger_event_wins_a_shared_cell(self):
        small = quake(mag=3.0, lat=0.1, lon=0.1, eid="small")
        big = quake(mag=7.0, lat=0.1, lon=0.1, eid="big")
        shot = worldmap.render([small, big], 40, 8)
        self.assertEqual(len(shot.markers), 1)
        self.assertEqual(shot.markers[0][4].id, "big")

    def test_offscreen_counted(self):
        shot = worldmap.render([quake(lat=-85.0, lon=0.0)], 40, 8)
        self.assertEqual((shot.plotted, shot.offscreen), (0, 1))

    def test_ascii_mode(self):
        shot = worldmap.render([], 30, 6, ascii_only=True)
        self.assertTrue(all(set(r) <= set("# ") for r in shot.rows))


class TestSequence(unittest.TestCase):
    def test_radius_grows_with_magnitude(self):
        radii = [service.aftershock_radius_km(m) for m in (4, 5, 6, 7, 8)]
        self.assertEqual(radii, sorted(radii))
        self.assertGreaterEqual(radii[0], 25.0)
        self.assertLessEqual(radii[-1], 400.0)
        self.assertEqual(service.aftershock_radius_km(None), 25.0)

    def _seq(self, main_mag=6.5, after=(), before=()):
        now = time.time()
        main = quake(mag=main_mag, when=now - 3 * 86400, eid="main")
        afters = [quake(mag=m, when=main.epoch + dt, eid="a%d" % i)
                  for i, (m, dt) in enumerate(after)]
        befores = [quake(mag=m, when=main.epoch - dt, eid="b%d" % i)
                   for i, (m, dt) in enumerate(before)]
        return service.Sequence(main, 50.0, 30.0, befores, afters, min_mag=3.0)

    def test_counts_and_largest(self):
        seq = self._seq(after=[(5.0, 3600), (4.0, 90000), (5.3, 7200)])
        self.assertEqual(len(seq.aftershocks), 3)
        self.assertEqual(seq.largest.magnitude, 5.3)
        self.assertEqual(seq.rate_first_day, 2)
        self.assertEqual(seq.counts_by_day(4), [2, 1, 0, 0])

    def test_bath_gap(self):
        seq = self._seq(main_mag=6.5, after=[(5.3, 3600)])
        self.assertAlmostEqual(seq.bath_gap(), 1.2, places=5)

    def test_empty_sequence_verdict(self):
        self.assertIn("No aftershocks", self._seq().verdict())

    def test_larger_foreshock_is_called_out(self):
        seq = self._seq(main_mag=5.0, after=[(3.5, 3600)],
                        before=[(6.2, 7200)])
        self.assertIn("larger event", seq.verdict().lower())
        self.assertEqual(seq.largest_foreshock.magnitude, 6.2)

    def test_decay_is_described(self):
        after = [(4.0, 600 * i) for i in range(1, 20)]      # all on day one
        self.assertIn("quietened", self._seq(after=after).verdict())


class TestActivity(unittest.TestCase):
    def make(self, recent, baseline, min_mag=2.5):
        return service.Activity("Testland", min_mag, 30.0, recent, 365.0,
                                baseline)

    def test_expected_and_ratio(self):
        act = self.make(100, 365)
        self.assertAlmostEqual(act.expected, 30.0)
        self.assertAlmostEqual(act.ratio, 100 / 30.0)

    def test_verdicts(self):
        self.assertIn("far above", self.make(300, 365).verdict())
        self.assertIn("About normal", self.make(30, 365).verdict())
        self.assertIn("far below", self.make(6, 365).verdict())
        self.assertIn("Too few", self.make(2, 24).verdict())

    def test_missing_baseline(self):
        act = self.make(10, None)
        self.assertIsNone(act.expected)
        self.assertIn("Not enough history", act.verdict())


class TestWatchFilter(unittest.TestCase):
    def test_magnitude_floor(self):
        flt = watch.Filter(min_mag=6.0)
        self.assertFalse(flt.matches(quake(mag=5.9)))
        self.assertTrue(flt.matches(quake(mag=6.0)))
        self.assertFalse(flt.matches(quake(mag=None)))

    def test_region_restriction(self):
        flt = watch.Filter(min_mag=4.0, region_names=["japan"])
        self.assertTrue(flt.matches(quake(mag=5.0, lat=35.7, lon=139.7)))
        self.assertFalse(flt.matches(quake(mag=5.0, lat=-33.0, lon=-70.0)))
        self.assertIn("Japan", flt.describe())

    def test_radius_restriction(self):
        flt = watch.Filter(min_mag=4.0, home=(35.68, 139.77), radius_km=200)
        self.assertTrue(flt.matches(quake(mag=5.0, lat=35.0, lon=139.0)))
        self.assertFalse(flt.matches(quake(mag=5.0, lat=0.0, lon=0.0)))

    def test_unknown_region_rejected(self):
        self.assertRaises(ValueError, watch.Filter, 4.0, ["qwertyuiop"])

    def test_seen_state_round_trip(self):
        watch.save_seen({"a": time.time()})
        self.assertIn("a", watch.load_seen())

    def test_seen_state_is_capped(self):
        big = dict(("id%d" % i, float(i)) for i in range(watch.STATE_MAX + 50))
        kept = watch.save_seen(big)
        self.assertEqual(len(kept), watch.STATE_MAX)

    def test_notifier_choice_does_not_crash(self):
        fn, name = watch.pick_notifier()
        self.assertTrue(name)

    def test_line_includes_distance_when_home_known(self):
        line = watch._line(quake(mag=5.0, lat=0, lon=0), home=(0.0, 1.0))
        self.assertIn("km", line)


class TestPlainOutput(unittest.TestCase):
    def test_rows_line_up(self):
        q = model.Quake.from_feature(FEATURE)
        header, row = plain._header("WHEN"), plain._row(q, "09-28 10:00")
        self.assertEqual(header.index("MAG") + 3, row.index("6.4") + 3)
        self.assertEqual(header.index("LOCATION"),
                         row.index("88 km NNW of Uken, Japan"))

    def test_home_column_appears(self):
        q = model.Quake.from_feature(FEATURE)
        row = plain._row(q, "09-28 10:00", home=(35.0, 139.0))
        self.assertIn("FROM HOME", plain._header("WHEN", home=True))
        self.assertTrue(row.strip().endswith("km"))

    def test_long_place_is_truncated(self):
        q = quake(place="x" * 200)
        row = plain._row(q, "09-28 10:00")
        self.assertNotIn("\n", row)
        self.assertLess(len(row), 120)

    def test_region_listing(self):
        out = io.StringIO()
        plain.list_regions(out)
        self.assertIn("Japan", out.getvalue())


class TestUiHelpers(unittest.TestCase):
    def test_spark(self):
        self.assertEqual(ui.spark([]), "")
        self.assertEqual(len(ui.spark([1, 2, 3])), 3)
        self.assertEqual(ui.spark([0, 0, 0]), ui.SPARK[0] * 3)
        bars = ui.spark([0, 5, 10])
        self.assertEqual(bars[-1], ui.SPARK[-1])
        self.assertTrue(set(ui.spark([1, 2], ascii_only=True)) <= set(" .:-=+*#"))


class TestLive(unittest.TestCase):
    """Only runs with --net."""

    def test_feed(self):
        from eqmon import api
        board = api.fetch_feed("day", 4.0)
        self.assertTrue(all(q.magnitude >= 4.0 for q in board.quakes if q.mag))

    def test_region_search_and_count(self):
        from eqmon import api
        res = service.search("japan", min_mag=4.0, days=30, limit=10)
        self.assertEqual(res.label, "Japan")
        if res.truncated:
            self.assertGreater(res.total, len(res.quakes))
        self.assertIsNotNone(api.count(min_mag=6.0, days=30))

    def test_radius_search(self):
        res = service.near(35.68, 139.77, radius_km=300, min_mag=3.0, days=30)
        self.assertEqual(res.radius_km, 300)


def _cleanup():
    shutil.rmtree(_TMP, ignore_errors=True)


if __name__ == "__main__":
    net = "--net" in sys.argv
    if net:
        sys.argv.remove("--net")
    loader = unittest.TestLoader()
    suite = unittest.TestSuite()
    cases = [TestModel, TestGeo, TestRegions, TestCache, TestConfig, TestMap,
             TestSequence, TestActivity, TestWatchFilter, TestPlainOutput,
             TestUiHelpers]
    if net:
        cases.append(TestLive)
    for case in cases:
        suite.addTests(loader.loadTestsFromTestCase(case))
    result = unittest.TextTestRunner(verbosity=1).run(suite)
    _cleanup()
    sys.exit(0 if result.wasSuccessful() else 1)
