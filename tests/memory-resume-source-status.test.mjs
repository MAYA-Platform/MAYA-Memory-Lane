import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { appendBlock } from '../lib/memoryLaneCore.js';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ml-resume-status-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'MANIFEST.json'), JSON.stringify({ blocks: [] }));
  for (const title of ['match', 'changed', 'missinghash', 'invalidhash', 'missingfile', 'readerror']) {
    appendBlock(root, { title, body: `Status body for ${title}.`, lineage: title });
  }
  const file = path.join(root, 'MANIFEST.json');
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  const blockPath = b => path.join(root, 'shelves', b.shelf, b.filename);
  fs.appendFileSync(blockPath(manifest.blocks[1]), '\nmodified');
  delete manifest.blocks[2].sha256;
  manifest.blocks[3].sha256 = 'invalid';
  fs.unlinkSync(blockPath(manifest.blocks[4]));
  fs.unlinkSync(blockPath(manifest.blocks[5]));
  fs.mkdirSync(blockPath(manifest.blocks[5]));
  fs.writeFileSync(file, JSON.stringify(manifest));
  return { root, blocks: manifest.blocks };
}

function cli(root, args) {
  return JSON.parse(execFileSync(process.execPath, ['tools/memory-lane-cli.mjs', ...args], {
    cwd: path.resolve('.'), encoding: 'utf8', timeout: 10000,
    env: { ...process.env, MEMORY_LANE_LIBRARY: root },
  }));
}

function mcp(root, calls) {
  const input = calls.map((params, i) => JSON.stringify({ jsonrpc: '2.0', id: i + 1,
    method: 'tools/call', params })).join('\n') + '\n';
  return execFileSync(process.execPath, ['tools/memory-lane-mcp.mjs'], {
    cwd: path.resolve('.'), input, encoding: 'utf8', timeout: 10000,
    env: { ...process.env, MEMORY_LANE_LIBRARY: root },
  }).trim().split('\n').map(JSON.parse).sort((a, b) => a.id - b.id);
}

const statuses = ['match', 'mismatch', 'missing', 'invalid', 'file_missing', 'read_error'];

test('CLI recent and resume distinguish hash and file conditions', t => {
  const { root, blocks } = fixture(t);
  const recent = cli(root, ['recent', '10']);
  assert.deepEqual(recent.blocks.map(b => b.manifest_hash_status), [...statuses].reverse());
  assert.match(recent.blocks.find(b => b.manifest_hash_status === 'mismatch').excerpt, /Status body/);
  for (let i = 0; i < blocks.length; i++) {
    const result = cli(root, ['resume', blocks[i].block_id]);
    assert.equal(result.found, true);
    assert.equal(result.blocks[0].manifest_hash_status, statuses[i]);
  }
});

test('MCP recent and resume show statuses with a non-authenticity caveat', t => {
  const { root, blocks } = fixture(t);
  const output = mcp(root, [
    { name: 'ml_recent', arguments: { limit: 10 } },
    { name: 'ml_resume', arguments: { phrase: blocks[1].block_id } },
  ]);
  const recent = output[0].result.content[0].text;
  for (const status of statuses) assert.ok(recent.includes(`[manifest hash: ${status}]`));
  assert.match(recent, /does not verify source truth, chain integrity, or manifest authenticity/);
  const resumed = output[1].result.content[0].text;
  assert.ok(resumed.includes('[manifest hash: mismatch]'));
  assert.match(resumed, /does not verify source truth, chain integrity, or manifest authenticity/);
});
