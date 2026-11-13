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
  const run = (expectedStatus = 0, extraArgs = []) => {
    const env = { ...process.env, MEMORY_LANE_LIBRARY: '', MERGE_API_KEY: '', MEMORY_LANE_JEV_ENABLED: '0' };
    const result = spawnSync(process.execPath, [importer, vault, '--library', library, ...extraArgs], { encoding: 'utf8', env });
    assert.equal(result.status, expectedStatus, result.stderr);
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
  fs.writeFileSync(path.join(library, 'MANIFEST.json'), JSON.stringify({ blocks: null }));
  fs.writeFileSync(note, '# Note\n\nAnother change.\n');
  const failure = run(1);
  assert.match(failure.stdout, /done: 0 imported, 0 skipped .* 1 failed/);
  assert.match(failure.stderr, /note\.md/);
  run(1, ['--quiet']);
});

test('vault import skips files over the configured size limit', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ml-vault-size-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const vault = path.join(root, 'vault');
  const library = path.join(root, 'library');
  fs.mkdirSync(vault);
  fs.writeFileSync(path.join(vault, 'small.md'), 'small note');
  fs.writeFileSync(path.join(vault, 'large.md'), 'x'.repeat(1025));
  const env = { ...process.env, MEMORY_LANE_LIBRARY: '', MERGE_API_KEY: '', MEMORY_LANE_JEV_ENABLED: '0' };
  const result = spawnSync(process.execPath, [importer, vault, '--library', library, '--max-kb', '1'], { encoding: 'utf8', env });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /done: 1 imported, 1 skipped .* 0 failed/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(library, 'MANIFEST.json'), 'utf8')).blocks.length, 1);
});

test('invalid size limits fail before initializing a library', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ml-vault-bad-size-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const library = path.join(root, 'library');
  const env = { ...process.env, MEMORY_LANE_LIBRARY: '', MERGE_API_KEY: '', MEMORY_LANE_JEV_ENABLED: '0' };
  for (const value of ['0', '-1', 'Infinity', 'invalid']) {
    const result = spawnSync(process.execPath, [importer, root, '--library', library, '--max-kb', value], { encoding: 'utf8', env });
    assert.equal(result.status, 2, result.stderr);
    assert.equal(fs.existsSync(library), false);
  }
});

test('an unreadable traversal target fails even in quiet mode', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ml-vault-scan-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const notDirectory = path.join(root, 'not-a-directory');
  fs.writeFileSync(notDirectory, 'fixture');
  const env = { ...process.env, MEMORY_LANE_LIBRARY: '', MERGE_API_KEY: '', MEMORY_LANE_JEV_ENABLED: '0' };
  const result = spawnSync(process.execPath, [importer, notDirectory, '--library', path.join(root, 'library'), '--quiet'], { encoding: 'utf8', env });
  assert.equal(result.status, 1, result.stderr);
});

test('a directory beyond the traversal depth fails instead of reporting completion', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ml-vault-depth-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const vault = path.join(root, 'vault');
  fs.mkdirSync(path.join(vault, ...Array(13).fill('d')), { recursive: true });
  const env = { ...process.env, MEMORY_LANE_LIBRARY: '', MERGE_API_KEY: '', MEMORY_LANE_JEV_ENABLED: '0' };
  const result = spawnSync(process.execPath, [importer, vault, '--library', path.join(root, 'library')], { encoding: 'utf8', env });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /maximum directory depth exceeded/);
});

test('a truncated candidate scan exits with failure', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ml-vault-limit-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const vault = path.join(root, 'vault');
  fs.mkdirSync(vault);
  for (let i = 0; i < 5001; i++) fs.writeFileSync(path.join(vault, `${i}.md`), '');
  const env = { ...process.env, MEMORY_LANE_LIBRARY: '', MERGE_API_KEY: '', MEMORY_LANE_JEV_ENABLED: '0' };
  const result = spawnSync(process.execPath, [importer, vault, '--library', path.join(root, 'library')], { encoding: 'utf8', env });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /maximum candidate count exceeded/);
});
