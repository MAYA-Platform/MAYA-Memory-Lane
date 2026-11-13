import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appendBlock, loadLibrary, search } from '../lib/memoryLaneCore.js';
import { graphSearch } from '../lib/graph.js';

test('reused library search sees changed file contents', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ml-search-refresh-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'MANIFEST.json'), JSON.stringify({ blocks: [] }));
  appendBlock(root, { title: 'first', body: 'pearword', lineage: 'first' });
  appendBlock(root, { title: 'second', body: 'appleword', lineage: 'second' });
  const library = loadLibrary(root);
  assert.equal(search(library, 'pearword').count, 1);
  fs.appendFileSync(library.blocks[1].filePath, '\npearword');
  assert.equal(search(library, 'pearword').count, 2);
});

test('same-size edits with restored timestamps and file replacement refresh search', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ml-search-replace-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'MANIFEST.json'), JSON.stringify({ blocks: [] }));
  appendBlock(root, { title: 'one', body: 'appleword', lineage: 'one' });
  appendBlock(root, { title: 'two', body: 'appleword', lineage: 'two' });
  const library = loadLibrary(root);
  assert.equal(search(library, 'appleword').count, 2);
  const file = library.blocks[1].filePath;
  const stat = fs.statSync(file);
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('appleword', 'pearwords'));
  fs.utimesSync(file, stat.atime, stat.mtime);
  assert.equal(search(library, 'appleword').count, 1);
  assert.equal(search(library, 'pearwords').count, 1);
  fs.unlinkSync(file);
  assert.equal(search(library, 'appleword').count, 1);
  fs.writeFileSync(file, 'appleword restored');
  assert.equal(search(library, 'appleword').count, 2);
});

test('graph index is refreshed when source facts change', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ml-graph-refresh-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'MANIFEST.json'), JSON.stringify({ blocks: [] }));
  appendBlock(root, { title: 'fact', body: 'Alice likes oranges.', lineage: 'fact' });
  const library = loadLibrary(root);
  assert.equal(graphSearch(library, 'oranges').count, 1);
  fs.writeFileSync(library.blocks[0].filePath, 'Alice likes bananas.');
  assert.equal(graphSearch(library, 'oranges').count, 0);
  assert.equal(graphSearch(library, 'bananas').count, 1);
});

test('an edit while an index is built cannot poison a later search', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ml-search-race-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'MANIFEST.json'), JSON.stringify({ blocks: [] }));
  appendBlock(root, { title: 'first', body: 'appleword', lineage: 'first' });
  appendBlock(root, { title: 'second', body: 'appleword', lineage: 'second' });
  const library = loadLibrary(root);
  const file = library.blocks[0].filePath;
  const original = fs.readFileSync(file);
  const originalRead = fs.readFileSync;
  let changed = false;
  fs.readFileSync = function (filePath, ...args) {
    const bytes = originalRead.call(this, filePath, ...args);
    if (!changed && filePath === file) {
      changed = true;
      fs.writeFileSync(file, original.toString('utf8').replace('appleword', 'pearwords'));
    }
    return bytes;
  };
  try { search(library, 'appleword'); } finally { fs.readFileSync = originalRead; }
  assert.equal(changed, true);
  fs.writeFileSync(file, original);
  assert.equal(search(library, 'appleword').count, 2);
});
