import errno
import importlib.util
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch


SPEC = importlib.util.spec_from_file_location('memory_inbox_watch', Path(__file__).resolve().parents[1] / 'tools' / 'inbox-watch.py')
watcher = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(watcher)


class ArchiveNoReplaceTest(unittest.TestCase):
    @unittest.skipUnless(shutil.which('node'), 'Node is required for the synthetic child')
    def test_existing_daily_archive_is_not_overwritten_after_ingestion(self):
        import datetime
        with tempfile.TemporaryDirectory(prefix='watch-archive-integration-') as directory:
            root = Path(directory)
            inbox, library, repo = root / 'inbox', root / 'library', root / 'repo'
            inbox.mkdir()
            library.mkdir()
            (repo / 'tools').mkdir(parents=True)
            (library / 'MANIFEST.json').write_text('{}', encoding='utf-8')
            (repo / 'tools' / 'ingest.mjs').write_text("console.log(JSON.stringify({block_id:'synthetic'}));", encoding='utf-8')
            source = inbox / 'note.txt'
            source.write_bytes(b'new synthetic')
            destination = inbox / 'processed' / datetime.date.today().isoformat() / 'note.txt'
            destination.parent.mkdir(parents=True)
            destination.write_bytes(b'old synthetic')
            env = {k: os.environ[k] for k in ('PATH', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP') if k in os.environ}
            result = subprocess.run([sys.executable, '-B', str(SPEC.origin), '--inbox', str(inbox), '--library', str(library),
                                     '--repo', str(repo), '--once'], capture_output=True, env=env, timeout=10)
            self.assertEqual(result.returncode, 0)
            self.assertEqual(source.read_bytes(), b'new synthetic')
            self.assertEqual(destination.read_bytes(), b'old synthetic')
            self.assertIn(b'inspect source and library before retry', result.stdout)

    def test_existing_target_and_source_are_preserved(self):
        with tempfile.TemporaryDirectory(prefix='watch-archive-') as directory:
            root = Path(directory)
            source, destination = root / 'incoming', root / 'processed'
            source.write_bytes(b'new synthetic')
            destination.write_bytes(b'old synthetic')
            with self.assertRaises(OSError):
                watcher.archive_noreplace(source, destination)
            self.assertEqual(source.read_bytes(), b'new synthetic')
            self.assertEqual(destination.read_bytes(), b'old synthetic')

    def test_parallel_sources_cannot_replace_a_winner(self):
        with tempfile.TemporaryDirectory(prefix='watch-archive-') as directory:
            root = Path(directory)
            target = root / 'processed'
            sources = [root / f'incoming-{i}' for i in range(8)]
            for index, source in enumerate(sources):
                source.write_bytes(f'synthetic-{index}'.encode())
            barrier = threading.Barrier(len(sources))
            def move(index):
                barrier.wait()
                try:
                    watcher.archive_noreplace(sources[index], target)
                    return index
                except OSError as error:
                    return error
            with ThreadPoolExecutor(max_workers=len(sources)) as pool:
                outcomes = list(pool.map(move, range(len(sources))))
            winners = [i for i in outcomes if isinstance(i, int)]
            unsupported = {errno.ENOSYS, errno.ENOTSUP, getattr(errno, 'EOPNOTSUPP', errno.ENOTSUP)}
            if (os.name != 'nt' and not winners and not target.exists()
                    and all(isinstance(e, OSError) and e.errno in unsupported for e in outcomes)):
                self.skipTest('atomic no-replace primitive unavailable on this filesystem')
            self.assertEqual(len(winners), 1)
            self.assertEqual(target.read_bytes(), f'synthetic-{winners[0]}'.encode())
            for index, source in enumerate(sources):
                if index != winners[0]:
                    self.assertEqual(source.read_bytes(), f'synthetic-{index}'.encode())

    def test_parallel_watchers_on_same_source_preserve_archive_bytes(self):
        with tempfile.TemporaryDirectory(prefix='watch-archive-same-') as directory:
            root = Path(directory)
            source, target = root / 'incoming', root / 'processed'
            source.write_bytes(b'synthetic')
            barrier = threading.Barrier(2)
            def move(_):
                barrier.wait()
                try:
                    watcher.archive_noreplace(source, target)
                    return True
                except OSError as error:
                    return error
            with ThreadPoolExecutor(max_workers=2) as pool:
                winners = list(pool.map(move, range(2)))
            unsupported = {errno.ENOSYS, errno.ENOTSUP, getattr(errno, 'EOPNOTSUPP', errno.ENOTSUP)}
            if (os.name != 'nt' and not any(value is True for value in winners) and source.exists()
                    and not target.exists() and all(isinstance(e, OSError) and e.errno in unsupported for e in winners)):
                self.skipTest('atomic no-replace primitive unavailable on this filesystem')
            # Windows may report success to both racing callers for the same
            # source; this primitive does not provide exactly-once receipts.
            self.assertTrue(any(value is True for value in winners))
            self.assertFalse(source.exists())
            self.assertEqual(target.read_bytes(), b'synthetic')

    @unittest.skipIf(os.name == 'nt', 'unsupported-platform check exercises POSIX fallback')
    def test_unsupported_platform_fails_closed(self):
        with tempfile.TemporaryDirectory(prefix='watch-archive-') as directory:
            root = Path(directory)
            source, destination = root / 'incoming', root / 'processed'
            source.write_bytes(b'synthetic')
            with patch.object(watcher.sys, 'platform', 'unsupported-synthetic'):
                with self.assertRaises(OSError) as failure:
                    watcher.archive_noreplace(source, destination)
            self.assertEqual(failure.exception.errno, errno.ENOTSUP)
            self.assertTrue(source.exists())
            self.assertFalse(destination.exists())


if __name__ == '__main__':
    unittest.main()
