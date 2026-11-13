import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
WATCHER = ROOT / 'tools' / 'inbox-watch.py'
FAKE_INGEST = r'''
import json, runpy, subprocess, sys
from pathlib import Path
watcher, inbox, library, repo = sys.argv[1:]
def fake_run(command, **kwargs):
    filename = Path(command[2]).name
    class Result:
        returncode = 1 if filename.startswith('failed-') else 0
        stderr = 'synthetic failure \U0001f680' if returncode else ''
        stdout = ('' if returncode else 'malformed synthetic receipt' if filename.startswith('uncertain-')
                  else json.dumps({'block_id': 'synthetic\U0001f680'}))
    return Result()
subprocess.run = fake_run
sys.argv = [watcher, '--inbox', inbox, '--library', library, '--repo', repo, '--once']
runpy.run_path(watcher, run_name='__main__')
'''


class WatchOutputTest(unittest.TestCase):
    def test_restricted_console_reports_moved_and_failed_files(self):
        with tempfile.TemporaryDirectory(prefix='memory-watcher-output-') as directory:
            root = Path(directory)
            inbox, library, repo = root / 'inbox', root / 'library', root / 'repo'
            inbox.mkdir()
            library.mkdir()
            (repo / 'tools').mkdir(parents=True)
            (library / 'MANIFEST.json').write_text('{}', encoding='utf-8')
            (repo / 'tools' / 'ingest.mjs').write_text('// synthetic stub', encoding='utf-8')
            success = inbox / 'success-🚀.txt'
            failure = inbox / 'failed-🚀.txt'
            uncertain = inbox / 'uncertain-🚀.txt'
            success.write_text('synthetic success', encoding='utf-8')
            failure.write_text('synthetic failure', encoding='utf-8')
            uncertain.write_text('synthetic uncertain result', encoding='utf-8')
            env = {k: os.environ[k] for k in ('PATH', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP') if k in os.environ}
            env['PYTHONIOENCODING'] = 'cp1252:strict'
            result = subprocess.run([sys.executable, '-B', '-c', FAKE_INGEST, str(WATCHER),
                                     str(inbox), str(library), str(repo)],
                                    capture_output=True, env=env, timeout=10)
            self.assertEqual(result.returncode, 0, result.stderr.decode('cp1252', errors='replace'))
            self.assertFalse(success.exists())
            moved = list((inbox / 'processed').glob('*/success-🚀.txt'))
            self.assertEqual(len(moved), 1)
            self.assertEqual(moved[0].read_text(encoding='utf-8'), 'synthetic success')
            self.assertTrue(failure.exists())
            self.assertTrue(uncertain.exists())
            self.assertIn(b'ML-WATCH', result.stdout)
            self.assertIn(b'failed-', result.stdout)
            self.assertIn(b'inspect source and library before retry', result.stdout)
            self.assertIn(b'may be retried', result.stdout)
            self.assertIn(b'uncertain-', result.stdout)
            self.assertIn(b'\\U0001f680', result.stdout)


if __name__ == '__main__':
    unittest.main()
