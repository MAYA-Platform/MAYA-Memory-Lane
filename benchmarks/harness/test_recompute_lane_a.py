import importlib.util
import math
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('audit', Path(__file__).with_name('recompute_lane_a.py'))
audit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit)


def row(qid, gold, ranked):
    return {'question_id': qid, 'gold_sessions': gold, 'retrieved_sessions': ranked}


class OfflineMetrics(unittest.TestCase):
    def test_first_hit_rank_weights_are_explicit_and_not_reciprocal_rank(self):
        rows = [row('one', ['g'], ['g']), row('two', ['g'], ['x', 'g']), row('three', ['g'], ['x', 'y', 'g'])]
        value = audit.summarize(rows, (3,))['metrics']['3']['custom_first_hit_log2']
        self.assertAlmostEqual(value, (1 + 1 / math.log2(3) + 1 / math.log2(4)) / 3)

    def test_all_gold_is_binary_not_fraction_and_abstentions_are_excluded(self):
        rows = [row('regular', ['g1', 'g2'], ['g1']), row('missing_abs', [], []),
                row('complete', ['g1', 'g2'], ['g1', 'g2'])]
        value = audit.summarize(rows, (2,))
        self.assertEqual(value['rows_total'], 3)
        self.assertEqual(value['excluded_abs'], 1)
        self.assertEqual(value['rows_scored'], 2)
        self.assertEqual(value['metrics']['2']['all_gold_recall'], 0.5)

    def test_duplicate_ranks_are_not_silently_collapsed(self):
        rows = [row('one', ['g'], ['x', 'x', 'g'])]
        value = audit.summarize(rows, (2, 3))
        self.assertEqual(value['rows_with_duplicate_retrieved_ids'], 1)
        self.assertEqual(value['metrics']['2']['all_gold_recall'], 0)
        self.assertEqual(value['metrics']['3']['all_gold_recall'], 1)

    def test_invalid_or_empty_gold_non_abstention_fails_closed(self):
        for rows in ([], [row('one', [], [])], [row('one', ['g'], ['x']), row('one', ['g'], [])]):
            with self.subTest(rows=rows), self.assertRaises(ValueError):
                audit.summarize(rows)


if __name__ == '__main__':
    unittest.main()
