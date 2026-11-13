import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { appendBlock, loadLibrary, readBlock, search } from '../lib/memoryLaneCore.js';
import { jevRank } from '../lib/jevrank.js';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ml-source-status-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'MANIFEST.json'), JSON.stringify({ blocks: [] }));
  for (const title of ['match', 'changed', 'missing', 'invalid', 'deleted']) {
    appendBlock(root, { title, body: 'uniquehandoff searchable', lineage: title });
  }
  const mf = path.join(root, 'MANIFEST.json');
  const manifest = JSON.parse(fs.readFileSync(mf, 'utf8'));
  const blockPath = entry => path.join(root, 'shelves', entry.shelf, entry.filename);
  fs.appendFileSync(blockPath(manifest.blocks[1]), '\nchanged after sealing');
  delete manifest.blocks[2].sha256;
  manifest.blocks[3].sha256 = 'not-a-sha256';
  fs.unlinkSync(blockPath(manifest.blocks[4]));
  fs.writeFileSync(mf, JSON.stringify(manifest));
  return { root, library: loadLibrary(root) };
}

test('search exposes match, mismatch, missing and invalid manifest hashes', t => {
  const { library } = fixture(t);
  const result = search(library, 'uniquehandoff');
  const status = Object.fromEntries(result.matches.map(m => [m.lineage, m.manifest_hash_status]));
  assert.deepEqual(status, { match: 'match', changed: 'mismatch', missing: 'missing', invalid: 'invalid' });
  assert.equal(result.matches.some(m => m.lineage === 'deleted'), false);
});

test('CLI includes status beside the same search excerpts', t => {
  const { root } = fixture(t);
  const output = execFileSync(process.execPath, ['tools/memory-lane-cli.mjs', 'search', 'uniquehandoff', '10'], {
    cwd: path.resolve('.'), encoding: 'utf8', env: { ...process.env, MEMORY_LANE_LIBRARY: root }, timeout: 10000,
  });
  const result = JSON.parse(output);
  const status = Object.fromEntries(result.matches.map(m => [m.block_id.split('_')[1], m.manifest_hash_status]));
  assert.deepEqual(status, { match: 'match', changed: 'mismatch', missing: 'missing', invalid: 'invalid' });
});

test('digest uses the original file bytes even when UTF-8 is invalid', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ml-raw-hash-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'MANIFEST.json'), JSON.stringify({ blocks: [] }));
  appendBlock(root, { title: 'bytes', body: 'uniquehandoff', lineage: 'bytes' });
  const manifestPath = path.join(root, 'MANIFEST.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const entry = manifest.blocks[0], file = path.join(root, 'shelves', entry.shelf, entry.filename);
  fs.appendFileSync(file, Buffer.from([0xff]));
  const bytes = fs.readFileSync(file);
  entry.sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  const library = loadLibrary(root);
  assert.equal(readBlock(library, entry.lib_id).sha256, entry.sha256);
  assert.equal(search(library, 'uniquehandoff').matches[0].manifest_hash_status, 'match');
});


test('Jev expansion reports hash status from the promoted excerpt bytes', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ml-expanded-hash-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'MANIFEST.json'), JSON.stringify({ blocks: [] }));
  for (const title of ['one', 'two', 'three']) {
    appendBlock(root, { title, body: 'uniquehandoff evidence', lineage: 'sharedtopic' });
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'MANIFEST.json'), 'utf8'));
  const target = manifest.blocks[2];
  fs.appendFileSync(path.join(root, 'shelves', target.shelf, target.filename), '\nchanged after sealing');
  const library = loadLibrary(root);
  const base = search(library, 'uniquehandoff').matches.filter(m => m.block_id !== target.block_id);
  assert.equal(base.length, 2);
  const oldFetch = globalThis.fetch, oldKey = process.env.MERGE_API_KEY;
  process.env.MERGE_API_KEY = 'synthetic-key';
  globalThis.fetch = async (_url, options) => {
    const keys = Object.keys(JSON.parse(options.body).questions);
    assert.equal(keys.length, 3);
    fs.writeFileSync(library.blocks[2].filePath, 'replacement after Jev captured the excerpt');
    return { ok: true, json: async () => ({ answers: Object.fromEntries(
      keys.map((key, index) => [key, { score: index === 2 ? 2 : 1 }])) }) };
  };
  try {
    const ranked = await jevRank(library, 'uniquehandoff', base);
    const promoted = ranked.matches.find(m => m.block_id === target.block_id);
    assert.equal(promoted.via, 'jev-lineage');
    assert.equal(promoted.manifest_hash_status, 'mismatch');
    assert.match(promoted.excerpt, /uniquehandoff/);
    assert.doesNotMatch(promoted.excerpt, /replacement after Jev/);
  } finally {
    globalThis.fetch = oldFetch;
    if (oldKey === undefined) delete process.env.MERGE_API_KEY; else process.env.MERGE_API_KEY = oldKey;
  }
});


test('MCP search labels matching, mismatched and unavailable hashes', t => {
  const { root } = fixture(t);
  const request = { jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: 'ml_search', arguments: { query: 'uniquehandoff', limit: 10, rerank: 'none' } } };
  const output = execFileSync(process.execPath, ['tools/memory-lane-mcp.mjs'], {
    cwd: path.resolve('.'), input: JSON.stringify(request) + '\n', encoding: 'utf8',
    env: { ...process.env, MEMORY_LANE_LIBRARY: root }, timeout: 10000,
  });
  const result = JSON.parse(output).result;
  assert.notEqual(result.isError, true);
  const text = result.content[0].text;
  for (const status of ['match', 'mismatch', 'missing', 'invalid']) {
    assert.ok(text.includes(`[manifest hash: ${status}]`));
  }
  assert.match(text, /does not verify source truth, chain integrity, or manifest authenticity/);
});
