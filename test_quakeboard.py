"""Offline tests: run with `python3 -m unittest -v test_quakeboard`.

Nothing here touches the network. Pass --net to also hit the live USGS
service: `python3 test_quakeboard.py --net`.
"""

import io
import sys
import time
import unittest

from eqmon import model, plain, regions

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

    def test_missing_magnitude_sorts_last_and_prints_safely(self):
        feat = {"id": "x", "properties": {"place": "nowhere"}, "geometry": {}}
        q = model.Quake.from_feature(feat)
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
        self.assertIn("UTC", self.q.utc_time())

    def test_tier_boundaries(self):
        def tier(mag):
            f = {"id": "i", "properties": {"mag": mag}, "geometry": {}}
            return model.Quake.from_feature(f).tier()
        self.assertEqual([tier(m) for m in (3.9, 4.0, 5.0, 6.0, 7.0, 9.1)],
                         [0, 1, 2, 3, 4, 4])

    def test_humanize_age(self):
        self.assertEqual(model.humanize_age(5), "5s ago")
        self.assertEqual(model.humanize_age(125), "2m ago")
        self.assertEqual(model.humanize_age(7200), "2h ago")
        self.assertEqual(model.humanize_age(400000), "4d ago")

    def test_age_never_negative_for_clock_skew(self):
        future = dict(FEATURE, properties=dict(FEATURE["properties"],
                                               time=(time.time() + 600) * 1000))
        self.assertEqual(model.Quake.from_feature(future).age_seconds(), 0.0)


class TestRegions(unittest.TestCase):
    def test_exact_and_alias(self):
        self.assertEqual(regions.resolve("Japan")[0], "japan")
        self.assertEqual(regions.resolve("usa")[0], "united states")
        self.assertEqual(regions.resolve("  TÜRKIYE ")[0], "turkey")
        self.assertEqual(regions.resolve("Japan")[2], "exact")

    def test_misspelling_is_flagged_as_a_guess(self):
        key, _, how = regions.resolve("chili")
        self.assertEqual(key, "chile")
        self.assertEqual(how, "guess")

    def test_unknown_place(self):
        self.assertIsNone(regions.resolve("qwertyuiop"))
        self.assertIsNone(regions.resolve("   "))

    def test_multi_box_countries(self):
        _, boxes, _ = regions.resolve("united states")
        self.assertGreater(len(boxes), 1)          # mainland, Alaska, Hawaii

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
                self.assertGreaterEqual(lo_lon, -360.0, name)
                self.assertLessEqual(hi_lon, 360.0, name)

    def test_aliases_point_at_real_entries(self):
        for alias, target in regions.ALIASES.items():
            self.assertIn(target, regions.BOXES, alias)

    def test_suggestions(self):
        self.assertTrue(regions.suggest("jap"))


class TestPlainOutput(unittest.TestCase):
    def test_rows_line_up(self):
        q = model.Quake.from_feature(FEATURE)
        header = plain._header("WHEN")
        row = plain._row(q, "09-28 10:00")
        # both columns are right-aligned, so the fields end together
        self.assertEqual(header.index("MAG") + 3, row.index("6.4") + 3)
        self.assertEqual(header.index("DEPTH") + len("DEPTH"),
                         row.index("35.7 km") + len("35.7 km"))
        self.assertEqual(header.index("LOCATION"),
                         row.index("88 km NNW of Uken, Japan"))

    def test_long_place_is_truncated_not_wrapped(self):
        feat = dict(FEATURE, properties=dict(FEATURE["properties"],
                                             place="x" * 200))
        row = plain._row(model.Quake.from_feature(feat), "09-28 10:00")
        self.assertNotIn("\n", row)
        self.assertLess(len(row), 120)

    def test_region_listing(self):
        out = io.StringIO()
        plain.list_regions(out)
        self.assertIn("Japan", out.getvalue())


class TestLive(unittest.TestCase):
    """Only runs with --net."""

    def test_feed_and_search(self):
        from eqmon import api, service
        board = api.fetch_feed("day", 4.0)
        self.assertTrue(all(q.magnitude >= 4.0 for q in board if q.mag))
        res = service.search("japan", min_mag=4.0, days=30, limit=50)
        self.assertEqual(res.label, "Japan")


if __name__ == "__main__":
    net = "--net" in sys.argv
    if net:
        sys.argv.remove("--net")
    loader = unittest.TestLoader()
    suite = unittest.TestSuite()
    for case in (TestModel, TestRegions, TestPlainOutput):
        suite.addTests(loader.loadTestsFromTestCase(case))
    if net:
        suite.addTests(loader.loadTestsFromTestCase(TestLive))
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    sys.exit(0 if result.wasSuccessful() else 1)
