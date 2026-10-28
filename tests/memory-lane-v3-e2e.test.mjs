import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { makeLibrary, policy } from './v3-fixtures.mjs';

const cwd = path.resolve(import.meta.dirname, '..');
const auth = token => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });

async function launch(t, library) {
  const probe = net.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const child = spawn(process.execPath, ['server.mjs'], { cwd,
    env: { ...process.env, PORT: String(port), MEMORY_LANE_LIBRARY: library.rootDir }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', b => { output += b; });
  child.stderr.on('data', b => { output += b; });
  t.after(async () => {
    if (child.exitCode === null) {
      child.kill();
      await new Promise(resolve => child.once('exit', resolve));
    }
  });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 80; i++) {
    if (child.exitCode !== null) throw Error(output);
    try { if ((await fetch(base)).ok) return base; } catch { /* bounded startup polling */ }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw Error('Test server failed to start');
}

test('V3 recent and query stay scoped across CLI, HTTP, and MCP; session anchors stay hidden', async t => {
  const lib = makeLibrary(t, [
    { body: 'Client alpha current project is Orchid migration A-491.', namespace: 'client-a' },
    { body: 'Client beta current project is Orchid migration B-492.', namespace: 'client-b' },
    { body: '@anchor {"type":"SESSION_OPEN","session_id":"synthetic"}', namespace: 'client-a', anchorType: 'SESSION_OPEN' },
  ]);
  fs.writeFileSync(path.join(lib.rootDir, 'access-policy.json'), JSON.stringify(policy()));
  const env = { ...process.env, MEMORY_LANE_LIBRARY: lib.rootDir, MEMORY_LANE_ACCESS_TOKEN: 'test-alice' };

  const recent = JSON.parse(execFileSync(process.execPath, ['tools/memory-lane-cli.mjs', 'recent', '5', 'Orchid'], { cwd, env, encoding: 'utf8' }));
  assert.equal(recent.selection, 'freshness');
  assert.equal(recent.blocks.length, 1);
  assert.match(recent.blocks[0].excerpt, /A-491/);
  assert.ok(!JSON.stringify(recent).includes('B-492'));
  assert.ok(!JSON.stringify(recent).includes('SESSION_OPEN'));

  const cliQuery = JSON.parse(execFileSync(process.execPath, ['tools/memory-lane-cli.mjs', 'query', JSON.stringify({ query: 'Orchid migration', bundle: true })], { cwd, env, encoding: 'utf8' }));
  assert.equal(cliQuery.evidence.length, 1);
  assert.ok(!JSON.stringify(cliQuery).includes('B-492'));

  const base = await launch(t, lib);
  const httpRecent = await fetch(base + '/api/v3/recent', { method: 'POST', headers: auth('test-alice'), body: JSON.stringify({ limit: 5, query: 'Orchid' }) });
  assert.equal(httpRecent.status, 200);
  const httpBody = await httpRecent.json();
  assert.equal(httpBody.blocks.length, 1);
  assert.ok(!JSON.stringify(httpBody).includes('B-492'));
  assert.equal((await fetch(base + '/api/v3/recent', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 401);

  const calls = [
    { name: 'ml_recent', arguments: { limit: 5, query: 'Orchid' } },
    { name: 'ml_query', arguments: { query: 'Orchid migration', bundle: true } },
  ].map((params, i) => JSON.stringify({ jsonrpc: '2.0', id: i + 1, method: 'tools/call', params })).join('\n') + '\n';
  const mcpLines = execFileSync(process.execPath, ['tools/memory-lane-mcp.mjs'], { cwd, env, input: calls, encoding: 'utf8' }).trim().split(/\r?\n/);
  assert.equal(mcpLines.length, 2);
  const mcp = mcpLines.map(line => JSON.parse(line));
  assert.ok(mcp.every(item => !item.result.isError));
  assert.ok(!mcpLines.join('\n').includes('B-492'));
  assert.ok(!mcpLines.join('\n').includes('SESSION_OPEN'));
});

test('Hermes provider declares V3, session-start selection, and lifecycle activity bridge', () => {
  const source = fs.readFileSync(path.join(cwd, 'hermes-plugin/memory-lane/__init__.py'), 'utf8');
  const manifest = fs.readFileSync(path.join(cwd, 'hermes-plugin/memory-lane/plugin.yaml'), 'utf8');
  assert.match(source, /"name": "ml_query"/);
  assert.match(source, /self\._format_recent_context\(5, query\)/);
  assert.match(source, /def on_user_message\(/);
  assert.match(source, /MEMORY_LANE_SESSION_URL/);
  assert.match(source, /MEMORY_LANE_NAMESPACE/);
  assert.match(manifest, /on_session_start/);
  assert.match(manifest, /on_user_message/);
});
