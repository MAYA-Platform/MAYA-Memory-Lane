import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { appendBlock } from '../lib/memoryLaneCore.js';

function fixture(t, count = 30) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ml-mcp-limit-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'MANIFEST.json'), JSON.stringify({ blocks: [] }));
  for (let i = 0; i < count; i++) appendBlock(root, { title: `Entry ${i}`, body: 'uniquehandoversample', lineage: `record${i}` });
  return root;
}

function calls(root, requests) {
  const input = requests.map((params, i) => JSON.stringify({ jsonrpc: '2.0', id: i + 1, method: 'tools/call', params })).join('\n') + '\n';
  const env = { ...process.env, MEMORY_LANE_LIBRARY: root, MEMORY_LANE_MERGE_CONFIG: path.join(root, 'missing-config') };
  for (const name of ['MERGE_API_KEY', 'MEMORY_LANE_API_KEY', 'OPENAI_API_KEY', 'DEEPSEEK_API_KEY']) delete env[name];
  const output = execFileSync(process.execPath, ['tools/memory-lane-mcp.mjs'], {
    cwd: path.resolve('.'), input, encoding: 'utf8', timeout: 20000, env,
  });
  return output.trim().split('\n').map(JSON.parse).sort((a, b) => a.id - b.id).map(r => r.result);
}

const rows = result => result.content[0].text.split('\n').filter(line => line.startsWith('• ')).length;

test('recent defaults remain five, valid requests preserve ordering, and oversized requests disclose the cap', t => {
  const root = fixture(t);
  const result = calls(root, [
    { name: 'ml_recent', arguments: {} },
    { name: 'ml_recent', arguments: { limit: 2 } },
    { name: 'ml_recent', arguments: { limit: 10000 } },
  ]);
  assert.deepEqual(result.map(rows), [5, 2, 25]);
  assert.match(result[0].content[0].text, /Showing 5 memory blocks\./);
  assert.match(result[2].content[0].text, /maximum 25/);
  assert.match(result[2].content[0].text, /Showing 25 memory blocks\./);
  const first = result[0].content[0].text.split('\n').find(line => line.startsWith('• '));
  assert.equal(result[1].content[0].text.split('\n').find(line => line.startsWith('• ')), first);
});

test('recent and search reject nonpositive, fractional, nonnumeric and nonfinite limits', t => {
  const root = fixture(t);
  const invalid = [null, -1, 0, 1.5, '', 'not-a-number', 'Infinity', true, [], 1e30];
  const requests = invalid.flatMap(limit => [
    { name: 'ml_recent', arguments: { limit } },
    { name: 'ml_search', arguments: { query: 'uniquehandoversample', limit, rerank: 'none' } },
  ]);
  for (const result of calls(root, requests)) {
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /positive integer/);
  }
});

test('search preserves default and positive numeric-string compatibility, and discloses a capped request', t => {
  const root = fixture(t);
  const result = calls(root, [
    { name: 'ml_search', arguments: { query: 'uniquehandoversample', rerank: 'none' } },
    { name: 'ml_search', arguments: { query: 'uniquehandoversample', limit: '2', rerank: 'none' } },
    { name: 'ml_search', arguments: { query: 'uniquehandoversample', limit: 10000, rerank: 'none' } },
  ]);
  assert.deepEqual(result.map(rows), [5, 2, 25]);
  assert.match(result[0].content[0].text, /5 result\(s\) returned.*additional matches may exist/);
  assert.match(result[1].content[0].text, /2 result\(s\) returned.*additional matches may exist/);
  assert.match(result[2].content[0].text, /maximum 25/);
});

test('limit boundary and empty results are explicit for both tools', t => {
  const root = fixture(t);
  const result = calls(root, ['ml_recent', 'ml_search'].flatMap(name => [25, 26].map(limit => ({
    name, arguments: name === 'ml_search' ? { query: 'uniquehandoversample', limit, rerank: 'none' } : { limit },
  }))));
  assert.deepEqual(result.map(rows), [25, 25, 25, 25]);
  assert.doesNotMatch(result[0].content[0].text, /capped/);
  assert.match(result[1].content[0].text, /capped/);
  assert.doesNotMatch(result[2].content[0].text, /capped/);
  assert.match(result[3].content[0].text, /capped/);
  const empty = calls(fixture(t, 0), [
    { name: 'ml_recent', arguments: {} },
    { name: 'ml_search', arguments: { query: 'uniquehandoversample', rerank: 'none' } },
  ]);
  assert.match(empty[0].content[0].text, /Library is empty/);
  assert.match(empty[1].content[0].text, /No matches/);
});
