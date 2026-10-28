import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { makeLibrary, policy } from './v3-fixtures.mjs';
import { loadLibrary } from '../lib/memoryLaneCore.js';

async function launch(t, library, env = {}) {
  const probe = net.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const child = spawn(process.execPath, ['server.mjs'], { cwd: path.resolve(import.meta.dirname, '..'),
    env: { ...process.env, PORT: String(port), MEMORY_LANE_LIBRARY: library.rootDir, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', b => { output += b; }); child.stderr.on('data', b => { output += b; });
  t.after(async () => { if (child.exitCode === null) { child.kill(); await new Promise(resolve => child.once('exit', resolve)); } });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 80; i++) {
    if (child.exitCode !== null) throw Error(output);
    try { const r = await fetch(base); if (r.ok) return base; } catch { /* bounded startup polling */ }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw Error('Test server failed to start');
}
const auth = token => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });

test('HTTP scoped search, answer and V3 query enforce policy before retrieval', async t => {
  const lib = makeLibrary(t, [
    { body: 'Alpha Orchid code A-491.', namespace: 'client-a' },
    { body: 'Beta Orchid code B-492.', namespace: 'client-b' }
  ]);
  const p = policy(), policyFile = path.join(lib.rootDir, 'access-policy.json');
  fs.writeFileSync(policyFile, JSON.stringify(p));
  const base = await launch(t, lib);
  assert.equal((await fetch(base + '/api/search?q=Orchid')).status, 401);
  const search = await (await fetch(base + '/api/search?q=Orchid', { headers: auth('test-alice') })).json();
  assert.equal(search.matches.length, 1);
  assert.ok(!JSON.stringify(search).includes('Beta'));
  assert.equal((await fetch(base + '/api/export', { headers: auth('test-alice') })).status, 403);
  const request = () => fetch(base + '/api/v3/query', { method: 'POST', headers: auth('test-alice'), body: JSON.stringify({ query: 'Orchid', bundle: true }) });
  const one = await (await request()).json();
  assert.equal(one.evidence.length, 1);
  const two = await (await request()).json();
  assert.equal(two.cache_hit, true);
  p.principals.alice.read = [];
  fs.writeFileSync(policyFile, JSON.stringify(p));
  const revoked = await (await request()).json();
  assert.equal(revoked.evidence.length, 0);
  fs.writeFileSync(policyFile, 'invalid json');
  assert.equal((await request()).status, 403);
});

test('HTTP namespace writes require explicit grant and preserve sealed ownership', async t => {
  const lib = makeLibrary(t), p = policy();
  fs.writeFileSync(path.join(lib.rootDir, 'access-policy.json'), JSON.stringify(p));
  const base = await launch(t, lib);
  const write = namespace => fetch(base + '/api/ingest', { method: 'POST', headers: auth('test-alice'),
    body: JSON.stringify({ namespace, text: 'Synthetic client deployment proposal.', facts: [] }) });
  assert.equal((await write('client-b')).status, 403);
  assert.equal((await write('client-a')).status, 201);
  const result = await (await fetch(base + '/api/v3/query', { method: 'POST', headers: auth('test-bob'), body: JSON.stringify({ query: 'Synthetic', bundle: true }) })).json();
  assert.equal(result.evidence.length, 0);
  assert.equal(loadLibrary(lib.rootDir).blocks.length, 1);
});

test('legacy write endpoint fails closed by default without configured token', async t => {
  const lib = makeLibrary(t);
  const base = await launch(t, lib, { MEMORY_LANE_WRITE_AUTH: '', MEMORY_LANE_WRITE_TOKEN: '' });
  const result = await fetch(base + '/api/ingest', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'Should never seal.' }) });
  assert.equal(result.status, 403);
  assert.equal(loadLibrary(lib.rootDir).blocks.length, 0);
});

import { execFileSync } from 'node:child_process';

test('CLI and MCP apply the same namespace policy as HTTP', t => {
  const lib = makeLibrary(t, [
    { body: 'Alpha Orchid code A-491.', namespace: 'client-a' },
    { body: 'Beta Orchid code B-492.', namespace: 'client-b' }
  ]);
  fs.writeFileSync(path.join(lib.rootDir, 'access-policy.json'), JSON.stringify(policy()));
  const cwd = path.resolve(import.meta.dirname, '..');
  const env = { ...process.env, MEMORY_LANE_LIBRARY: lib.rootDir, MEMORY_LANE_ACCESS_TOKEN: 'test-alice' };
  const cli = JSON.parse(execFileSync(process.execPath, ['tools/memory-lane-cli.mjs', 'search', 'Orchid'], { cwd, env, encoding: 'utf8' }));
  assert.equal(cli.evidence.length, 1);
  assert.ok(!JSON.stringify(cli).includes('Beta'));
  const blockedResume = JSON.parse(execFileSync(process.execPath, ['tools/memory-lane-cli.mjs', 'resume', 'Orchid'], { cwd, env, encoding: 'utf8' }));
  assert.match(blockedResume.error, /disabled for policy-scoped/);
  const calls = [
    { id: 1, name: 'ml_recent', arguments: { limit: 5, query: 'Orchid' } },
    { id: 2, name: 'ml_query', arguments: { query: 'Orchid migration', bundle: true } },
    { id: 3, name: 'ml_search', arguments: { query: 'Orchid' } },
    { id: 4, name: 'ml_answer', arguments: { question: 'Which Orchid?' } },
    { id: 5, name: 'ml_resume', arguments: { phrase: 'Orchid' } },
  ];
  const input = calls.map(item => JSON.stringify({ jsonrpc: '2.0', id: item.id, method: 'tools/call', params: { name: item.name, arguments: item.arguments } })).join('\n') + '\n';
  const lines = execFileSync(process.execPath, ['tools/memory-lane-mcp.mjs'], { cwd, env, input, encoding: 'utf8' }).trim().split(/\r?\n/);
  const responses = new Map(lines.map(line => { const item = JSON.parse(line); return [item.id, item.result]; }));
  assert.equal(responses.size, 5);
  assert.ok([1, 2, 3, 4].every(id => !responses.get(id).isError));
  assert.equal(responses.get(5).isError, true);
  assert.ok(!lines.join('\n').includes('B-492'));
  assert.ok(!lines.join('\n').includes('SESSION_OPEN'));
});

test('projection maintenance dry run performs no library writes', t => {
  const lib = makeLibrary(t, [{ body: 'Orchid synthetic observation.' }]);
  const policyFile = path.join(lib.rootDir, 'access-policy.json');
  fs.writeFileSync(policyFile, JSON.stringify(policy()));
  const tokenFile = path.join(lib.rootDir, 'test-token'); fs.writeFileSync(tokenFile, 'test-owner');
  const before = fs.readFileSync(path.join(lib.rootDir, 'MANIFEST.json'), 'utf8');
  const result = JSON.parse(execFileSync(process.execPath, ['tools/v3-project.mjs', '--library', lib.rootDir, '--token-file', tokenFile, '--backfill', '1'], {
    cwd: path.resolve(import.meta.dirname, '..'), env: process.env, encoding: 'utf8'
  }));
  assert.equal(result.dry_run, true);
  assert.equal(fs.existsSync(path.join(lib.rootDir, 'projections')), false);
  assert.equal(fs.readFileSync(path.join(lib.rootDir, 'MANIFEST.json'), 'utf8'), before);
});

test('authenticated session endpoint seals anchors asynchronously and keeps them out of answers', async t => {
  const lib = makeLibrary(t), p = policy();
  fs.writeFileSync(path.join(lib.rootDir, 'access-policy.json'), JSON.stringify(p));
  const base = await launch(t, lib);
  const send = token => fetch(base + '/api/v3/session', { method: 'POST', headers: auth(token), body: JSON.stringify({
    namespace: 'client-a', sessionId: 'http-session', timestamp: '2026-10-16T00:00:00Z', runtime: 'http-test', sketch: 'Synthetic anchor sketch.'
  }) });
  assert.equal((await send('test-bob')).status, 403);
  assert.equal((await send('test-alice')).status, 202);
  for (let i = 0; i < 40 && loadLibrary(lib.rootDir).blocks.length === 0; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(loadLibrary(lib.rootDir).blocks.length, 1);
  const result = await (await fetch(base + '/api/v3/query', { method: 'POST', headers: auth('test-alice'), body: JSON.stringify({ query: 'Synthetic', bundle: true }) })).json();
  assert.equal(result.evidence.length, 0);
});

test('removing an active access policy never downgrades a running service to open reads', async t => {
  const lib = makeLibrary(t, [{ body: 'Orchid owner-only source.' }]);
  const file = path.join(lib.rootDir, 'access-policy.json');
  fs.writeFileSync(file, JSON.stringify(policy()));
  const base = await launch(t, lib);
  const first = await fetch(base + '/api/search?q=Orchid', { headers: auth('test-owner') });
  assert.equal(first.status, 200);
  fs.unlinkSync(file);
  assert.equal((await fetch(base + '/api/search?q=Orchid')).status, 403);
});
