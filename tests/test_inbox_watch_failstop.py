import datetime
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
WATCHER = ROOT / 'tools' / 'inbox-watch.py'
SCRIPT = r'''
import fs from 'node:fs';
import path from 'node:path';
const name = path.basename(process.argv[2]);
fs.appendFileSync('effects.log', name + '\n');
if (name.startsWith('bad')) process.stdout.write('malformed synthetic receipt');
else if (name.startsWith('invalid')) process.stdout.write('{}');
else process.stdout.write(JSON.stringify({ok:true,block_id:'synthetic',lib_id:1}));
'''


@unittest.skipUnless(shutil.which('node'), 'Node is required for the synthetic child')
class WatchFailStopTest(unittest.TestCase):
    def fixture(self, root):
        inbox, library, repo = root / 'inbox', root / 'library', root / 'repo'
        inbox.mkdir()
        library.mkdir()
        (repo / 'tools').mkdir(parents=True)
        (library / 'MANIFEST.json').write_text('{}', encoding='utf-8')
        (repo / 'tools' / 'ingest.mjs').write_text(SCRIPT, encoding='utf-8')
        env = {k: os.environ[k] for k in ('PATH', 'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR') if k in os.environ}
        env.update(TEMP=str(root), TMP=str(root), USERPROFILE=str(root), LOCALAPPDATA=str(root))
        args = [sys.executable, '-B', str(WATCHER), '--inbox', str(inbox), '--library', str(library), '--repo', str(repo)]
        return inbox, repo, args, env

    def test_once_stops_after_unconfirmed_ingestion(self):
        with tempfile.TemporaryDirectory(prefix='watch-failstop-') as directory:
            inbox, repo, args, env = self.fixture(Path(directory))
            (inbox / 'bad.txt').write_text('synthetic bad', encoding='utf-8')
            (inbox / 'later.txt').write_text('synthetic later', encoding='utf-8')
            result = subprocess.run([*args, '--once'], env=env, capture_output=True, timeout=10)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual((repo / 'effects.log').read_text().splitlines(), ['bad.txt'])
            self.assertTrue((inbox / 'bad.txt').exists())
            self.assertTrue((inbox / 'later.txt').exists())
            self.assertIn(b'inspect', result.stdout)

    def test_loop_exits_before_retrying_uncertain_file(self):
        with tempfile.TemporaryDirectory(prefix='watch-failstop-loop-') as directory:
            inbox, repo, args, env = self.fixture(Path(directory))
            (inbox / 'bad.txt').write_text('synthetic bad', encoding='utf-8')
            result = subprocess.run([*args, '--loop', '1'], env=env, capture_output=True, timeout=4)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual((repo / 'effects.log').read_text().splitlines(), ['bad.txt'])
            self.assertTrue((inbox / 'bad.txt').exists())

    def test_success_exit_with_incomplete_receipt_does_not_archive(self):
        with tempfile.TemporaryDirectory(prefix='watch-failstop-receipt-') as directory:
            inbox, repo, args, env = self.fixture(Path(directory))
            source = inbox / 'invalid.txt'
            source.write_text('synthetic', encoding='utf-8')
            result = subprocess.run([*args, '--once'], env=env, capture_output=True, timeout=10)
            self.assertNotEqual(result.returncode, 0)
            self.assertTrue(source.exists())
            self.assertEqual((repo / 'effects.log').read_text().splitlines(), ['invalid.txt'])
            self.assertIn(b'ingest receipt invalid; outcome unconfirmed', result.stdout)

    def test_success_and_empty_inbox_exit_zero(self):
        with tempfile.TemporaryDirectory(prefix='watch-failstop-success-') as directory:
            inbox, repo, args, env = self.fixture(Path(directory))
            (inbox / 'ok.txt').write_text('synthetic ok', encoding='utf-8')
            result = subprocess.run([*args, '--once'], env=env, capture_output=True, timeout=10)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual((repo / 'effects.log').read_text().splitlines(), ['ok.txt'])
            self.assertEqual(len(list((inbox / 'processed').glob('*/ok.txt'))), 1)
            idle = subprocess.run([*args, '--once'], env=env, capture_output=True, timeout=10)
            self.assertEqual(idle.returncode, 0)
            self.assertEqual(idle.stdout, b'')

    def test_archive_collision_returns_nonzero_and_preserves_files(self):
        with tempfile.TemporaryDirectory(prefix='watch-failstop-collision-') as directory:
            inbox, repo, args, env = self.fixture(Path(directory))
            source = inbox / 'ok.txt'
            source.write_bytes(b'new synthetic')
            dest = inbox / 'processed' / datetime.date.today().isoformat() / 'ok.txt'
            dest.parent.mkdir(parents=True)
            dest.write_bytes(b'old synthetic')
            result = subprocess.run([*args, '--once'], env=env, capture_output=True, timeout=10)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(source.read_bytes(), b'new synthetic')
            self.assertEqual(dest.read_bytes(), b'old synthetic')
            self.assertEqual((repo / 'effects.log').read_text().splitlines(), ['ok.txt'])


if __name__ == '__main__':
    unittest.main()
