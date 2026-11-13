import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

test('disconnected HTTP searches and answers release waiting slots', async t => {
  const probe = net.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const root = path.resolve('.');
  const env = {...process.env, PORT: String(port)};
  delete env.MEMORY_LANE_LIBRARY;
  delete env.MERGE_API_KEY;
  const child = spawn(process.execPath, ['--import', pathToFileURL(path.join(root, 'tests/fixtures/slow-search-cancel.mjs')).href,
    path.join(root, 'server.mjs')], {env, stdio: ['ignore', 'ignore', 'pipe', 'ipc']});
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  t.after(() => child.kill());
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 8000;
  while (true) {
    try { if ((await fetch(`${base}/api/status`)).ok) break; } catch { /* starting */ }
    if (Date.now() >= deadline || child.exitCode !== null) throw new Error(`test server did not start: ${stderr}`);
    await pause(30);
  }
  await fetch(`${base}/api/load-sample`, {method: 'POST'});
  for (const route of ['search', 'answer']) {
    const started = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('snapshot did not start')), 3000);
      child.once('message', () => { clearTimeout(timer); resolve(); });
    });
    const active = fetch(`${base}/api/search?q=memory`);
    await started;
    const cancelled = http.get(`${base}/api/${route}?q=memory`);
    cancelled.on('error', () => {});
    const waiting = Array.from({length: 3}, () => fetch(`${base}/api/search?q=memory`));
    await pause(120);
    cancelled.destroy();
    await pause(120);
    const replacement = fetch(`${base}/api/search?q=memory`);
    const responses = await Promise.all([active, ...waiting, replacement]);
    assert.deepEqual(responses.map(response => response.status), [200, 200, 200, 200, 200]);
  }
});
