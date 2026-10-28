import importlib.util
import pathlib
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]


def load(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / 'scripts' / f'{name}.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


collect = load('collect_metrics')
report = load('report_metrics')


def measurements():
    return [dict(schema=1, scenario='twenty', mode=mode, repeat=repeat, experiment='test', browser_version='1',
                 machine='arm64', macos='test', conditions='same', memory_method='rss', cpu_method='ps',
                 duration_seconds=60, interval_seconds=5, restore_latency_ms=[],
                 summary={'rss_mib_mean': 800 if mode == 'extension' else 1000, 'cpu_percent_mean': 1})
            for mode in report.MODES for repeat in (1, 2, 3)]


class MetricsTests(unittest.TestCase):
    def test_profile_requires_exact_path_not_prefix(self):
        self.assertTrue(collect.matches_profile('Chrome --user-data-dir=/tmp/lab --no-first-run', '/tmp/lab'))
        self.assertFalse(collect.matches_profile('Chrome --user-data-dir=/tmp/lab-other', '/tmp/lab'))

    def test_tree_excludes_unrelated_browser_and_includes_grandchildren(self):
        table = {1: {'ppid': 0}, 2: {'ppid': 1}, 3: {'ppid': 2}, 4: {'ppid': 0}, 5: {'ppid': 4}}
        self.assertEqual(collect.tree_ids(table, 1), {1, 2, 3})

    def test_missing_and_duplicate_runs_cannot_pass(self):
        runs = measurements()
        self.assertIn('Висновок не сформовано', '\n'.join(report.compare(runs[:-1], 'twenty')))
        self.assertIn('Висновок не сформовано', '\n'.join(report.compare(runs + [runs[0]], 'twenty')))

    def test_mismatched_conditions_cannot_pass(self):
        runs = measurements()
        runs[0]['conditions'] = 'different'
        self.assertIn('не збігаються', '\n'.join(report.compare(runs, 'twenty')))

    def test_complete_measurements_compare_medians(self):
        text = '\n'.join(report.compare(measurements(), 'twenty'))
        self.assertIn('20.0%', text)
        self.assertIn('**досягнуто**', text)
        self.assertIn('не виміряно', text)

    def test_cpu_regression_fails_gate(self):
        runs = measurements()
        for run in runs:
            if run['mode'] == 'extension':
                run['summary']['cpu_percent_mean'] = 7
        self.assertIn('**не досягнуто**', '\n'.join(report.compare(runs, 'twenty')))


if __name__ == '__main__':
    unittest.main()
