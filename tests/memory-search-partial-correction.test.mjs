import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appendBlock, loadLibrary, search, searchAsync } from '../lib/memoryLaneCore.js';

test('partial substring query finds a corrected source even when FTS has another exact-token hit', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ml-partial-correction-'));
  t.after(() => fs.rmSync(root, {recursive:true, force:true}));
  fs.writeFileSync(path.join(root, 'MANIFEST.json'), JSON.stringify({blocks:[]}));
  appendBlock(root, {title:'one', body:'ear', lineage:'one'});
  appendBlock(root, {title:'two', body:'banana', lineage:'two'});
  const library = loadLibrary(root);
  assert.equal(search(library, 'ear').count, 1);
  fs.writeFileSync(library.blocks[1].filePath, 'pearword corrected');
  assert.equal(search(library, 'ear').count, 1);
  assert.equal((await searchAsync(library, 'ear', {infix:'true'})).count, 1);
  for (const result of [search(library, 'ear', {infix:true}), await searchAsync(library, 'ear', {infix:true})]) {
    assert.equal(result.count, 2);
    assert.ok(result.matches.some(row => row.lib_id === library.blocks[1].lib_id && row.excerpt.includes('pearword')));
    assert.equal(new Set(result.matches.map(row => row.lib_id)).size, 2);
  }
  assert.equal(search(library, 'ear', {limit:1, infix:true}).count, 1);
  fs.writeFileSync(library.blocks[1].filePath, 'banana corrected again');
  assert.equal((await searchAsync(library, 'ear', {infix:true})).count, 1);
});

test('direct substring gets the remaining slot before a graph-only neighbor', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ml-partial-priority-'));
  t.after(() => fs.rmSync(root, {recursive:true, force:true}));
  fs.writeFileSync(path.join(root, 'MANIFEST.json'), JSON.stringify({blocks:[]}));
  appendBlock(root, {title:'A', body:'Alex leased a Honda Civic and loves hiking.', lineage:'auto'});
  appendBlock(root, {title:'B', body:'Alex also owns a kayak for lake trips.', lineage:'auto'});
  appendBlock(root, {title:'C', body:'dayhiking notebook', lineage:'auto'});
  const lib = loadLibrary(root);
  assert.deepEqual(search(lib,'hiking',{limit:2}).matches.map(row => row.lib_id), [lib.blocks[0].lib_id, lib.blocks[1].lib_id]);
  for (const result of [search(lib,'hiking',{limit:2,infix:true}), await searchAsync(lib,'hiking',{limit:2,infix:true})]) {
    assert.deepEqual(result.matches.map(row => row.lib_id), [lib.blocks[0].lib_id, lib.blocks[2].lib_id]);
  }
});
