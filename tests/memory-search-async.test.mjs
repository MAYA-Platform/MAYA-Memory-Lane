import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
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

for (const scenario of [
  {name: 'FTS', old: 'appleword', newer: 'pearwords', query: 'appleword', fts: true},
  {name: 'substring fallback', old: '记忆', newer: '丢失', query: '记忆', fts: false}
]) {
  test(`${scenario.name} result and hash use captured bytes if the file changes after its read`, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ml-evidence-race-'));
    t.after(() => fs.rmSync(root, {recursive: true, force: true}));
    fs.writeFileSync(path.join(root, 'MANIFEST.json'), JSON.stringify({blocks: []}));
    appendBlock(root, {title: 'one', body: `${scenario.old} evidence`, lineage: 'testlineage'});
    const library = loadLibrary(root);
    const entry = library.blocks[0];
    const captured = fs.readFileSync(entry.filePath);
    const current = Buffer.from(captured.toString('utf8').replace(scenario.old, scenario.newer));
    entry.sha256 = crypto.createHash('sha256').update(current).digest('hex');
    const originalRead = fs.promises.readFile;
    let changed = false;
    fs.promises.readFile = async function (file, ...args) {
      const data = await originalRead.call(this, file, ...args);
      if (file === entry.filePath && !changed) { fs.writeFileSync(file, current); changed = true; }
      return data;
    };
    let result;
    try { result = await searchAsync(library, scenario.query); }
    finally { fs.promises.readFile = originalRead; }
    assert.equal(changed, true);
    assert.equal(result.count, 1);
    const match = result.matches[0];
    assert.equal(match.block_id, entry.block_id);
    assert.equal(match.lineage, entry.lineage);
    assert.match(match.excerpt, new RegExp(scenario.old));
    assert.doesNotMatch(match.excerpt, new RegExp(scenario.newer));
    assert.equal(match.manifest_hash_status, 'mismatch');
    if (scenario.fts) assert.equal(typeof match.score, 'number');
    assert.equal((await searchAsync(library, scenario.query)).count, 0);
  });
}

test('concurrent searches bound snapshots and reject excess waiters explicitly', async () => {
  const originalRead = fs.promises.readFile;
  const active = new Map();
  let peakReaders = 0, peakCorpora = 0;
  fs.promises.readFile = async (file) => {
    const owner = file.split('/')[0];
    active.set(owner, (active.get(owner) || 0) + 1);
    peakReaders = Math.max(peakReaders, [...active.values()].reduce((a, b) => a + b, 0));
    peakCorpora = Math.max(peakCorpora, active.size);
    try { await new Promise(resolve => setTimeout(resolve, 2)); return Buffer.from('记忆'); }
    finally { const n = active.get(owner) - 1; if (n) active.set(owner, n); else active.delete(owner); }
  };
  const libraries = Array.from({length: 6}, (_, group) => ({blocks:
    Array.from({length: 48}, (_, i) => ({lib_id: i, block_id: `b${group}-${i}`, filePath: `${group}/${i}`}))
  }));
  try {
    const outcomes = await Promise.allSettled(libraries.map(l => searchAsync(l, '记忆', {limit: 1})));
    assert.equal(outcomes.filter(o => o.status === 'fulfilled' && o.value.count === 1).length, 5);
    const rejected = outcomes.filter(o => o.status === 'rejected');
    assert.equal(rejected.length, 1);
    assert.equal(rejected[0].reason.code, 'MEMORY_SEARCH_BUSY');
    assert.equal(peakCorpora, 1);
    assert.ok(peakReaders <= 16);
    assert.equal((await searchAsync(libraries[5], '记忆', {limit: 1})).count, 1);
  } finally { fs.promises.readFile = originalRead; }
});

test('a graph-only result uses its captured bytes and hash after an edit', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ml-graph-evidence-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  fs.writeFileSync(path.join(root, 'MANIFEST.json'), JSON.stringify({blocks: []}));
  appendBlock(root, {title: 'A', body: 'Alex leased a Honda Civic and loves hiking.', lineage: 'auto'});
  appendBlock(root, {title: 'B', body: 'Alex also owns a kayak for lake trips.', lineage: 'auto'});
  const library = loadLibrary(root);
  const target = library.blocks[1];
  const current = Buffer.from('replacement content with no graph relationship');
  target.sha256 = crypto.createHash('sha256').update(current).digest('hex');
  const originalRead = fs.promises.readFile;
  fs.promises.readFile = async function (file, ...args) {
    const data = await originalRead.call(this, file, ...args);
    if (file === target.filePath) fs.writeFileSync(file, current);
    return data;
  };
  let result;
  try { result = await searchAsync(library, 'hiking'); }
  finally { fs.promises.readFile = originalRead; }
  const graph = result.matches.find(m => m.lib_id === target.lib_id);
  assert.equal(graph.via, 'graph');
  assert.match(graph.excerpt, /Alex also owns/);
  assert.equal(graph.manifest_hash_status, 'mismatch');
  assert.equal((await searchAsync(library, 'hiking')).matches.some(m => m.lib_id === target.lib_id), false);
});

test('a failed active search releases the queue for later searches', async () => {
  const originalRead = fs.promises.readFile;
  fs.promises.readFile = async file => {
    await new Promise(resolve => setTimeout(resolve, 2));
    if (file === 'bad') throw Object.assign(new Error('denied'), {code: 'EACCES'});
    return Buffer.from('记忆');
  };
  const library = filePath => ({blocks: [{lib_id: 1, block_id: 'one', filePath}]});
  try {
    const [failed, next] = await Promise.allSettled([
      searchAsync(library('bad'), '记忆'), searchAsync(library('good'), '记忆')
    ]);
    assert.equal(failed.status, 'rejected');
    assert.equal(failed.reason.code, 'EACCES');
    assert.equal(next.status, 'fulfilled');
    assert.equal(next.value.count, 1);
  } finally { fs.promises.readFile = originalRead; }
});

test('aborted waiting search frees its slot without reading its library', async () => {
  const originalRead = fs.promises.readFile;
  let unblock;
  let began;
  const started = new Promise(resolve => { began = resolve; });
  const held = new Promise(resolve => { unblock = resolve; });
  const reads = [];
  fs.promises.readFile = async file => {
    reads.push(file);
    if (file === 'active') { began(); await held; }
    return Buffer.from('记忆');
  };
  const library = filePath => ({ blocks: [{ lib_id: 1, block_id: filePath, filePath }] });
  const controller = new AbortController();
  try {
    const active = searchAsync(library('active'), '记忆');
    await started;
    const cancelled = searchAsync(library('cancelled'), '记忆', { signal: controller.signal });
    const rejection = assert.rejects(cancelled, { code: 'ABORT_ERR' });
    const waiting = ['one', 'two', 'three'].map(name => searchAsync(library(name), '记忆'));
    await assert.rejects(searchAsync(library('full'), '记忆'), { code: 'MEMORY_SEARCH_BUSY' });
    controller.abort();
    await rejection;
    const replacement = searchAsync(library('replacement'), '记忆');
    unblock();
    await Promise.all([active, ...waiting, replacement]);
    assert.deepEqual(reads, ['active', 'one', 'two', 'three', 'replacement']);
  } finally {
    unblock();
    fs.promises.readFile = originalRead;
  }
});

test('a previously aborted search does not take a search slot', async () => {
  const controller = new AbortController();
  controller.abort();
  const library = { blocks: [] };
  await assert.rejects(searchAsync(library, '记忆', { signal: controller.signal }), { code: 'ABORT_ERR' });
  assert.equal((await searchAsync(library, '记忆')).count, 0);
});
