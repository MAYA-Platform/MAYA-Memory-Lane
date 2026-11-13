import os
from pathlib import Path
import subprocess
import shutil
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
        returncode = 1 if filename.startswith('b-failed-') else 0
        stderr = ('synthetic failure \U0001f680' if returncode else '').encode('utf-8')
        stdout = ('' if returncode else 'malformed synthetic receipt' if filename.startswith('c-uncertain-')
                  else json.dumps({'ok': True, 'block_id': 'synthetic\U0001f680', 'lib_id': 1})).encode('utf-8')
    return Result()
subprocess.run = fake_run
sys.argv = [watcher, '--inbox', inbox, '--library', library, '--repo', repo, '--once']
runpy.run_path(watcher, run_name='__main__')
'''


class WatchOutputTest(unittest.TestCase):
    def check_console(self, encoding):
        with tempfile.TemporaryDirectory(prefix='memory-watcher-output-') as directory:
            root = Path(directory)
            inbox, library, repo = root / 'inbox', root / 'library', root / 'repo'
            inbox.mkdir()
            library.mkdir()
            (repo / 'tools').mkdir(parents=True)
            (library / 'MANIFEST.json').write_text('{}', encoding='utf-8')
            (repo / 'tools' / 'ingest.mjs').write_text('// synthetic stub', encoding='utf-8')
            success = inbox / 'a-success-🚀.txt'
            failure = inbox / 'b-failed-🚀.txt'
            uncertain = inbox / 'c-uncertain-🚀.txt'
            success.write_text('synthetic success', encoding='utf-8')
            failure.write_text('synthetic failure', encoding='utf-8')
            uncertain.write_text('synthetic uncertain result', encoding='utf-8')
            env = {k: os.environ[k] for k in ('PATH', 'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR') if k in os.environ}
            env.update(TEMP=str(root), TMP=str(root), USERPROFILE=str(root), LOCALAPPDATA=str(root))
            env['PYTHONIOENCODING'] = encoding
            result = subprocess.run([sys.executable, '-B', '-c', FAKE_INGEST, str(WATCHER),
                                     str(inbox), str(library), str(repo)],
                                    capture_output=True, env=env, timeout=10)
            self.assertEqual(result.returncode, 1, result.stderr.decode('cp1252', errors='replace'))
            self.assertFalse(success.exists())
            moved = list((inbox / 'processed').glob('*/a-success-🚀.txt'))
            self.assertEqual(len(moved), 1)
            self.assertEqual(moved[0].read_text(encoding='utf-8'), 'synthetic success')
            self.assertTrue(failure.exists())
            self.assertTrue(uncertain.exists())
            self.assertIn(b'ML-WATCH', result.stdout)
            self.assertIn(b'failed-', result.stdout)
            self.assertIn(b'inspect source and library before restarting', result.stdout)
            self.assertIn(b'separate scheduled runs may retry', result.stdout)
            self.assertNotIn(b'uncertain-', result.stdout)
            if encoding.startswith('cp1252'):
                self.assertIn(b'\\U0001f680', result.stdout)
            else:
                self.assertIn('🚀'.encode('utf-8'), result.stdout)

    def test_restricted_console_reports_moved_and_failed_files(self):
        self.check_console('cp1252:strict')

    def test_utf8_console_preserves_unicode(self):
        self.check_console('utf-8:strict')

    @unittest.skipUnless(shutil.which('node'), 'Node is required for the synthetic child')
    def test_real_child_utf8_and_malformed_receipts(self):
        for case in ('valid', 'invalid_stdout', 'invalid_stderr'):
            with self.subTest(case=case), tempfile.TemporaryDirectory(prefix='memory-watcher-child-') as directory:
                root = Path(directory)
                inbox, library, repo = root / 'inbox', root / 'library', root / 'repo'
                inbox.mkdir()
                library.mkdir()
                (repo / 'tools').mkdir(parents=True)
                (library / 'MANIFEST.json').write_text('{}', encoding='utf-8')
                script = ("process.stdout.write(Buffer.from([0xff]));" if case == 'invalid_stdout' else
                          "process.stdout.write(JSON.stringify({ok:true,block_id:'\\u0401',lib_id:1}));" +
                          ("process.stderr.write(Buffer.from([0xff]));" if case == 'invalid_stderr' else ''))
                (repo / 'tools' / 'ingest.mjs').write_text(script, encoding='utf-8')
                source = inbox / 'synthetic.txt'
                source.write_text('synthetic only', encoding='utf-8')
                env = {k: os.environ[k] for k in ('PATH', 'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR') if k in os.environ}
                env.update(TEMP=str(root), TMP=str(root), USERPROFILE=str(root), LOCALAPPDATA=str(root))
                env.update(PYTHONIOENCODING='cp1252:strict', PYTHONUTF8='0')
                result = subprocess.run([sys.executable, '-B', str(WATCHER), '--inbox', str(inbox),
                                         '--library', str(library), '--repo', str(repo), '--once'],
                                        capture_output=True, env=env, timeout=10)
                self.assertEqual(result.returncode, 0 if case == 'valid' else 1, result.stderr.decode('cp1252', errors='replace'))
                if case == 'valid':
                    self.assertFalse(source.exists())
                    self.assertEqual(len(list((inbox / 'processed').glob('*/synthetic.txt'))), 1)
                    self.assertIn(b'\\u0401', result.stdout)
                else:
                    self.assertTrue(source.exists())
                    self.assertIn(b'inspect source and library before restarting', result.stdout)
                    self.assertIn(b'ingest output is not valid UTF-8; outcome unconfirmed', result.stdout)
                    self.assertNotIn(b'Exception in thread', result.stderr)
                    self.assertNotIn(b'Traceback', result.stderr)


if __name__ == '__main__':
    unittest.main()
