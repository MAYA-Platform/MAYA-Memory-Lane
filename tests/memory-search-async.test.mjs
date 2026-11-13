import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appendBlock, loadLibrary, search, searchAsync } from '../lib/memoryLaneCore.js';
import { captureLibrarySnapshot, captureLibrarySnapshotAsync } from '../lib/libraryFingerprint.js';

test('asynchronous search keeps exact-byte freshness and search results', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ml-async-search-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'MANIFEST.json'), JSON.stringify({ blocks: [] }));
  appendBlock(root, { title: 'one', body: 'appleword', lineage: 'one' });
  appendBlock(root, { title: 'two', body: 'appleword', lineage: 'two' });
  const library = loadLibrary(root);
  assert.deepEqual(await searchAsync(library, 'appleword'), search(library, 'appleword'));
  const file = library.blocks[1].filePath;
  const before = fs.statSync(file);
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('appleword', 'pearwords'));
  fs.utimesSync(file, before.atime, before.mtime);
  assert.equal((await searchAsync(library, 'appleword')).count, 1);
  assert.equal((await searchAsync(library, 'pearwords')).count, 1);
  fs.unlinkSync(file);
  assert.equal((await searchAsync(library, 'pearwords')).count, 0);
  fs.writeFileSync(file, 'pearwords restored');
  assert.equal((await searchAsync(library, 'pearwords')).count, 1);
});

test('concurrent asynchronous snapshots share a bounded read limit', async () => {
  const original = fs.promises.readFile;
  let active = 0, peak = 0;
  fs.promises.readFile = async () => {
    active++;
    peak = Math.max(peak, active);
    try {
      await new Promise(resolve => setTimeout(resolve, 1));
      return Buffer.from('synthetic content');
    } finally { active--; }
  };
  try {
    const blocks = Array.from({length: 40}, (_, i) => ({lib_id: i, block_id: `b${i}`, filePath: `f${i}`}));
    const snapshots = await Promise.all(Array.from({length: 3}, () => captureLibrarySnapshotAsync({blocks})));
    assert.ok(peak <= 16, `opened ${peak} reads simultaneously`);
    assert.equal(snapshots[0].fingerprint, snapshots[1].fingerprint);
    assert.equal(snapshots[0].blocks.size, 40);
  } finally { fs.promises.readFile = original; }
});

test('async snapshot fingerprint matches sync snapshot for present and missing files', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ml-async-snapshot-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const present = path.join(root, 'present.md');
  fs.writeFileSync(present, Buffer.from([0xff, 0xfe, 0x61]));
  const library = { blocks: [
    {lib_id: 1, block_id: 'one', filePath: present},
    {lib_id: 2, block_id: 'missing', filePath: path.join(root, 'missing.md')}
  ] };
  assert.deepEqual(await captureLibrarySnapshotAsync(library), captureLibrarySnapshot(library));
});

test('an edit during an async snapshot cannot poison the next search', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ml-async-race-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  fs.writeFileSync(path.join(root, 'MANIFEST.json'), JSON.stringify({blocks: []}));
  appendBlock(root, {title: 'one', body: 'appleword', lineage: 'one'});
  const library = loadLibrary(root);
  const file = library.blocks[0].filePath;
  const original = fs.readFileSync(file);
  const originalRead = fs.promises.readFile;
  let changed = false;
  fs.promises.readFile = async function (filePath, ...args) {
    const bytes = await originalRead.call(this, filePath, ...args);
    if (!changed && filePath === file) {
      changed = true;
      fs.writeFileSync(file, original.toString('utf8').replace('appleword', 'pearwords'));
    }
    return bytes;
  };
  try { await searchAsync(library, 'appleword'); } finally { fs.promises.readFile = originalRead; }
  assert.equal(changed, true);
  fs.writeFileSync(file, original);
  assert.equal((await searchAsync(library, 'appleword')).count, 1);
});

test('an unreadable source fails rather than being treated as absent', async () => {
  const original = fs.promises.readFile;
  fs.promises.readFile = async () => { throw Object.assign(new Error('synthetic denial'), {code: 'EACCES'}); };
  try {
    await assert.rejects(captureLibrarySnapshotAsync({blocks: [{lib_id: 1, block_id: 'one', filePath: 'denied'}]}),
      {code: 'EACCES'});
  } finally { fs.promises.readFile = original; }
});

test('changed library metadata during an async read fails explicitly', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ml-async-metadata-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const file = path.join(root, 'one.md');
  fs.writeFileSync(file, 'synthetic');
  const library = {blocks: [{lib_id: 1, block_id: 'one', filePath: file}]};
  const original = fs.promises.readFile;
  fs.promises.readFile = async function (...args) {
    const data = await original.apply(this, args);
    library.blocks[0].block_id = 'renamed';
    return data;
  };
  try {
    await assert.rejects(captureLibrarySnapshotAsync(library), /metadata changed during search/);
  } finally { fs.promises.readFile = original; }
});

test('non-ASCII fallback works and a miss does not re-read every file synchronously', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ml-async-fallback-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  fs.writeFileSync(path.join(root, 'MANIFEST.json'), JSON.stringify({blocks: []}));
  appendBlock(root, {title: 'one', body: '记忆很重要', lineage: 'one'});
  appendBlock(root, {title: 'two', body: 'ordinary content', lineage: 'two'});
  const library = loadLibrary(root);
  assert.equal((await searchAsync(library, '记忆')).count, 1);
  const paths = new Set(library.blocks.map(block => block.filePath));
  const originalRead = fs.readFileSync;
  let rereads = 0;
  fs.readFileSync = function (file, ...args) {
    if (paths.has(file)) rereads++;
    return originalRead.call(this, file, ...args);
  };
  try { assert.equal((await searchAsync(library, 'nomatchingphrase')).count, 0); }
  finally { fs.readFileSync = originalRead; }
  assert.equal(rereads, 0);
});
