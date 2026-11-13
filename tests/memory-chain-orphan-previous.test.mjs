import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { appendBlock, loadLibrary, verifyChain } from '../lib/memoryLaneCore.js';

function syntheticLibrary(t, autoCleanup = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ml-orphan-link-'));
  if (autoCleanup) t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'MANIFEST.json'), JSON.stringify({ blocks: [] }));
  assert.equal(appendBlock(root, { title: 'One', body: 'Synthetic first record', lineage: 'alpha' }).ok, true);
  assert.equal(appendBlock(root, { title: 'Two', body: 'Synthetic second record', lineage: 'beta' }).ok, true);
  return root;
}

function changeSecond(root, transform) {
  const file = path.join(root, 'MANIFEST.json');
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  transform(manifest.blocks[1]);
  fs.writeFileSync(file, JSON.stringify(manifest));
  return verifyChain(loadLibrary(root));
}

test('a predecessor fingerprint without an ID is reported as unverified', t => {
  const root = syntheticLibrary(t);
  assert.equal(verifyChain(loadLibrary(root)).status, 'intact');
  const result = changeSecond(root, entry => { entry.prev_block_id = null; });
  assert.equal(result.status, 'unchecked');
  assert.equal(result.intact, false);
  assert.equal(result.blocks[1].prevCheck.status, 'unchecked');
});

test('own record hash mismatch remains an issue with an orphan predecessor fingerprint', t => {
  const root = syntheticLibrary(t);
  const result = changeSecond(root, entry => { entry.prev_block_id = null; entry.sha256 = '0'.repeat(64); });
  assert.equal(result.status, 'issues');
  assert.equal(result.blocks[1].status, 'hash_mismatch');
  assert.equal(result.blocks[1].prevCheck.status, 'unchecked');
});

test('two records with neither predecessor field do not establish whether links are missing', t => {
  const root = syntheticLibrary(t);
  const result = changeSecond(root, entry => { entry.prev_block_id = null; entry.prev_sha256 = null; });
  assert.notEqual(result.status, 'issues');
});


test('HTTP status and chain expose an orphan predecessor as unchecked', { timeout: 20000 }, async t => {
  const root = syntheticLibrary(t, false);
  changeSecond(root, entry => { entry.prev_block_id = null; });
  const env = { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, PATH: process.env.PATH,
    HOME: root, USERPROFILE: root, TEMP: root, TMP: root, LOCALAPPDATA: root,
    MEMORY_LANE_LIBRARY: root, MEMORY_LANE_MERGE_CONFIG: path.join(root, 'absent-config'), PORT: '0' };
  // Capture the port from this exact child only after its server is listening.
  const bootstrap = `const http = require('node:http');
    const create = http.createServer;
    http.createServer = function (...args) {
      const server = create.apply(this, args);
      server.once('listening', () => process.send({ port: server.address().port }));
      return server;
    };
    import('./server.mjs').catch(() => process.exit(1));`;
  const child = spawn(process.execPath, ['-e', bootstrap], { cwd: path.resolve('.'), env, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  let ended = false, spawnError;
  child.once('error', error => { spawnError = error; ended = true; });
  child.once('exit', () => { ended = true; });
  async function waitStopped(ms) {
    const deadline = Date.now() + ms;
    while (!ended && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
    return ended;
  }
  try {
    const port = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('isolated server startup timed out')), 10000);
      child.once('message', message => { clearTimeout(timer); resolve(message?.port); });
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', () => { clearTimeout(timer); reject(new Error('isolated server exited during startup')); });
    });
    assert.ok(Number.isSafeInteger(port) && port > 0 && port <= 65535);
    const response = await fetch(`http://127.0.0.1:${port}/api/status`, { signal: AbortSignal.timeout(3000) });
    assert.equal(response.ok, true);
    const status = await response.json();
    assert.equal(status.library, root);
    assert.equal(status.chain.status, 'unchecked');
    assert.equal(status.chain.intact, false);
    const chainResponse = await fetch(`http://127.0.0.1:${port}/api/chain`, { signal: AbortSignal.timeout(3000) });
    assert.equal(chainResponse.ok, true);
    const chain = await chainResponse.json();
    assert.equal(chain.status, 'unchecked');
    assert.equal(chain.blocks[1].prevCheck.status, 'unchecked');
  } finally {
    if (!ended) { try { child.kill('SIGTERM'); } catch { /* escalation follows */ } }
    if (!await waitStopped(1000) && !ended) { try { child.kill('SIGKILL'); } catch { /* retain if still running */ } }
    if (!await waitStopped(2000)) {
      if (child.connected) child.disconnect();
      child.unref();
      throw new Error(`isolated server exit not confirmed; retained synthetic library at ${root}`);
    }
    if (spawnError) throw spawnError;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
