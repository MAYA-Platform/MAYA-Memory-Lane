import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

test('search and answer do not return old-library results after a library switch', async t => {
  const socket = net.createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  const root = path.resolve('.');
  const env = {...process.env, PORT: String(port)};
  delete env.MEMORY_LANE_LIBRARY;
  delete env.MERGE_API_KEY;
  const child = spawn(process.execPath, ['--import', pathToFileURL(path.join(root, 'tests/fixtures/delay-snapshot-read.mjs')).href,
    path.join(root, 'server.mjs')], {env, stdio: ['ignore', 'ignore', 'pipe', 'ipc']});
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  t.after(() => child.kill());
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 8000;
  while (true) {
    try { if ((await fetch(`${base}/api/status`)).ok) break; } catch { /* starting */ }
    if (Date.now() >= deadline || child.exitCode !== null) throw new Error(`test server did not start: ${stderr}`);
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  for (const route of ['search', 'answer']) {
    assert.equal((await fetch(`${base}/api/load-sample`, {method: 'POST'})).status, 200);
    const started = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('snapshot did not start')), 3000);
      child.once('message', () => { clearTimeout(timer); resolve(); });
    });
    const pending = fetch(`${base}/api/${route}?q=memory`);
    await started;
    assert.equal((await fetch(`${base}/api/load-empty`, {method: 'POST'})).status, 200);
    const response = await pending;
    assert.equal(response.status, 409);
    const body = await response.json();
    assert.equal(body.ok, false);
    assert.match(body.error, /Library changed/);
    assert.equal('matches' in body, false);
    assert.equal('answer' in body, false);
  }
  assert.equal((await fetch(`${base}/api/load-sample`, {method: 'POST'})).status, 200);
  const burst = await Promise.all(Array.from({length: 6}, () => fetch(`${base}/api/search?q=memory`)));
  assert.equal(burst.filter(response => response.status === 200).length, 5);
  const busy = burst.find(response => response.status === 503);
  assert.ok(busy);
  assert.equal(busy.headers.get('retry-after'), '1');
  assert.match((await busy.json()).error, /busy.*retry/i);
});
