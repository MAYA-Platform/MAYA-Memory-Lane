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
  for (const result of [search(library, 'ear'), await searchAsync(library, 'ear')]) {
    assert.equal(result.count, 2);
    assert.ok(result.matches.some(row => row.lib_id === library.blocks[1].lib_id && row.excerpt.includes('pearword')));
    assert.equal(new Set(result.matches.map(row => row.lib_id)).size, 2);
  }
  assert.equal(search(library, 'ear', {limit:1}).count, 1);
  fs.writeFileSync(library.blocks[1].filePath, 'banana corrected again');
  assert.equal((await searchAsync(library, 'ear')).count, 1);
});
