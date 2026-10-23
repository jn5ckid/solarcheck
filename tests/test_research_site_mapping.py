import unittest

from prep.build_research_site_mapping import (
    bin_five_degrees,
    normal_angles,
    surface_group_id,
)


class ResearchSiteMappingTest(unittest.TestCase):
    def test_normal_angles_use_north_clockwise_convention(self):
        cases = [
            ((0, 1, 0), (0, 90)),
            ((1, 0, 0), (90, 90)),
            ((0, -1, 0), (180, 90)),
            ((-1, 0, 0), (270, 90)),
            ((0, 0, 1), (0, 0)),
        ]
        for normal, expected in cases:
            with self.subTest(normal=normal):
                actual = normal_angles(*normal)
                self.assertAlmostEqual(actual[0], expected[0])
                self.assertAlmostEqual(actual[1], expected[1])

    def test_five_degree_bin_wraps_azimuth(self):
        self.assertEqual(bin_five_degrees(357.6, wrap=True), 0)
        self.assertEqual(bin_five_degrees(2.6, wrap=True), 5)
        self.assertEqual(bin_five_degrees(88.0), 90)

    def test_surface_group_id_is_explicitly_a_normal_bin(self):
        self.assertEqual(surface_group_id("B0", "Facade", 103.2, 89.4), "B0:F:A105:T090")
        self.assertEqual(surface_group_id("B0", "Roof", 0.0, 0.0), "B0:R:A000:T000")


if __name__ == "__main__":
    unittest.main()
