import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const importer = fileURLToPath(new URL('../tools/import-vault.mjs', import.meta.url));

test('vault import reports actual new, duplicate, changed and failed offers', (t) => {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'ml-vault-receipt-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const vault = path.join(root, 'vault');
  const library = path.join(root, 'library');
  fs.mkdirSync(vault);
  const note = path.join(vault, 'note.md');
  fs.writeFileSync(note, '# Note\n\nOriginal content.\n');
  const run = () => {
    const env = { ...process.env, MEMORY_LANE_LIBRARY: '', MERGE_API_KEY: '', MEMORY_LANE_JEV_ENABLED: '0' };
    const result = spawnSync(process.execPath, [importer, vault, '--library', library], { encoding: 'utf8', env });
    assert.equal(result.status, 0, result.stderr);
    return result;
  };
  const count = () => JSON.parse(fs.readFileSync(path.join(library, 'MANIFEST.json'), 'utf8')).blocks.length;
  assert.match(run().stdout, /done: 1 imported, 0 skipped .* 0 failed/);
  assert.equal(count(), 1);
  const duplicate = run();
  assert.match(duplicate.stdout, /already imported/);
  assert.match(duplicate.stdout, /done: 0 imported, 1 skipped .* 0 failed/);
  assert.equal(count(), 1);
  fs.writeFileSync(note, '# Note\n\nChanged content.\n');
  assert.match(run().stdout, /done: 1 imported, 0 skipped .* 0 failed/);
  assert.equal(count(), 2);
  fs.writeFileSync(path.join(library, '.append.lock'), 'fixture');
  fs.writeFileSync(note, '# Note\n\nAnother change.\n');
  const failure = run();
  assert.match(failure.stdout, /done: 0 imported, 0 skipped .* 1 failed/);
  assert.match(failure.stderr, /note\.md/);
  assert.equal(count(), 2);
});
