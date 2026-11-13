import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function startSandbox(t, mounted) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-observe-test-'));
  assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
  let server;
  t.after(() => {
    if (server) server.kill();
    fs.rmSync(root, { recursive: true, force: true });
  });
  fs.copyFileSync(path.join(ROOT, 'server.mjs'), path.join(root, 'server.mjs'));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ type: 'module' }));
  for (const dir of ['lib', 'empty-library', 'sample-library']) {
    fs.cpSync(path.join(ROOT, dir), path.join(root, dir), { recursive: true });
  }
  let external = path.join(root, 'mounted');
  if (mounted === true) fs.cpSync(path.join(root, 'empty-library'), external, { recursive: true });
  if (mounted === 'empty' || mounted === 'sample') external = path.join(root, `${mounted}-library`);
  if (mounted === 'alias') {
    external = path.join(root, 'demo-alias');
    fs.symlinkSync(path.join(root, 'empty-library'), external, 'junction');
  }

  const listener = net.createServer();
  await new Promise((resolve, reject) => listener.once('error', reject).listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, PORT: String(port) };
  if (mounted) env.MEMORY_LANE_LIBRARY = external;
  server = spawn(process.execPath, [path.join(root, 'server.mjs')], { env, stdio: 'ignore' });
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 8000;
  let ready = false;
  while (Date.now() < deadline) {
    try { if ((await fetch(`${base}/api/status`)).ok) { ready = true; break; } } catch { /* startup */ }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(ready, 'isolated server did not start');
  return { root, external, base };
}

async function post(base, body) {
  return fetch(`${base}/api/observe`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
}

test('observation writes require an explicitly mounted library, even in sample mode', async (t) => {
  const { root, base } = await startSandbox(t, false);
  const message = { message: 'I prefer a synthetic fixture' };
  assert.equal((await post(base, message)).status, 400);
  assert.equal(fs.existsSync(path.join(root, 'empty-library', 'observations.jsonl')), false);
  assert.equal((await fetch(`${base}/api/load-sample`, { method: 'POST' })).status, 200);
  assert.equal((await post(base, message)).status, 400);
  assert.equal(fs.existsSync(path.join(root, 'sample-library', 'observations.jsonl')), false);
});

test('mounted observation receipts and injected pins reflect distinct stored records', async (t) => {
  const { external, base } = await startSandbox(t, true);
  const response = await post(base, { messages: [
    { message: 'I prefer the fixture theme', session_id: 'a' },
    { message: 'I prefer the fixture theme', session_id: 'a' },
    { message: 'I prefer 東京', session_id: 'a' },
    { message: 'I prefer 大阪', session_id: 'a' },
    { message: `I prefer ${'x'.repeat(85)} blue`, session_id: 'a' },
    { message: `I prefer ${'x'.repeat(85)} red`, session_id: 'a' },
  ] });
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.captured, 5);
  assert.equal(data.stats.total, 5);
  assert.equal(data.observations.length, 5);
  assert.equal(fs.readFileSync(path.join(external, 'observations.jsonl'), 'utf8').trim().split('\n').length, 5);
  const injected = await (await fetch(`${base}/api/inject?pins=fixture`)).json();
  assert.equal((injected.snapshot.match(/I prefer the fixture theme/g) || []).length, 1);
});

for (const mounted of ['empty', 'sample', 'alias']) {
  test(`an explicit ${mounted} demo path cannot be used to write`, async (t) => {
    const { root, base } = await startSandbox(t, mounted);
    const write = await fetch(`${base}/api/ingest`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'synthetic fixture', facts: [] }),
    });
    assert.equal(write.status, 400);
    assert.equal((await post(base, { message: 'I prefer a synthetic fixture' })).status, 400);
    for (const name of ['empty-library', 'sample-library']) {
      assert.equal(fs.existsSync(path.join(root, name, 'observations.jsonl')), false);
    }
  });
}
