import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// D9 (Packet 14 gap closure): MEMORY_LANE_LIBRARY must be validated against
// traversal and (optionally) an allowlisted library root BEFORE the server or
// MCP bridge loads anything. Fail closed, exit 78 (EX_CONFIG).

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const { validateLibraryPath } = await import('../lib/memoryLaneCore.js');

// ── Unit: validateLibraryPath ─────────────────────────────────────────

test('unset env is legitimate (blank boot stays the upstream default)', () => {
  const v = validateLibraryPath(undefined);
  assert.equal(v.ok, true);
  assert.equal(v.unset, true);
  const v2 = validateLibraryPath(null);
  assert.equal(v2.ok, true);
});

test('set-but-empty env is refused', () => {
  const v = validateLibraryPath('   ');
  assert.equal(v.ok, false);
  assert.match(v.problems[0], /set but empty/);
});

test('clean absolute path passes', () => {
  const v = validateLibraryPath(path.join(ROOT, 'sample-library'));
  assert.equal(v.ok, true);
  assert.equal(v.resolved, path.resolve(path.join(ROOT, 'sample-library')));
});

test('leading ../ traversal is refused', () => {
  const v = validateLibraryPath('../other-tenant');
  assert.equal(v.ok, false);
  assert.match(v.problems.join(' '), /'\.\.' traversal/);
});

test('mid-path ..\\ traversal is refused (Windows separator)', () => {
  const v = validateLibraryPath('E:\\MAYA_BULK\\memory-lane-live\\..\\other-tenant');
  assert.equal(v.ok, false);
  assert.match(v.problems.join(' '), /'\.\.' traversal/);
});

test('mid-path ../ traversal is refused (POSIX separator)', () => {
  const v = validateLibraryPath('E:/MAYA_BULK/memory-lane-live/../other-tenant');
  assert.equal(v.ok, false);
  assert.match(v.problems.join(' '), /'\.\.' traversal/);
});

test('allowlist: path outside every root is refused', () => {
  process.env.MEMORY_LANE_LIBRARY_ALLOWLIST = path.join(ROOT, 'sample-library');
  try {
    const v = validateLibraryPath('C:/definitely/not/allowlisted');
    assert.equal(v.ok, false);
    assert.match(v.problems.join(' '), /escapes every allowlisted root/);
  } finally {
    delete process.env.MEMORY_LANE_LIBRARY_ALLOWLIST;
  }
});

test('allowlist: path inside a root passes', () => {
  process.env.MEMORY_LANE_LIBRARY_ALLOWLIST = ROOT;
  try {
    const v = validateLibraryPath(path.join(ROOT, 'sample-library'));
    assert.equal(v.ok, true);
  } finally {
    delete process.env.MEMORY_LANE_LIBRARY_ALLOWLIST;
  }
});

test('no allowlist env set: any non-traversal path passes (default unchanged)', () => {
  delete process.env.MEMORY_LANE_LIBRARY_ALLOWLIST;
  const v = validateLibraryPath('D:/some/other/library');
  assert.equal(v.ok, true);
});

// ── Boot behavior: the real D9 vector ─────────────────────────────────

/** Spawn a repo entrypoint with extra env and wait for it to exit. */
function spawnUntilExit(entryRelPath, extraEnv, timeoutMs = 10000) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, entryRelPath)], {
      env: { ...process.env, ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stderr = '';
    let stdout = '';
    child.stderr.on('data', (d) => { stderr += String(d); });
    child.stdout.on('data', (d) => { stdout += String(d); });
    const timer = setTimeout(() => {
      child.kill();
      resolve({ code: 'timeout', stderr, stdout });
    }, timeoutMs);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, stderr, stdout });
    });
  });
}

test('server.mjs refuses a MEMORY_LANE_LIBRARY with ../ traversal (exit 78)', async () => {
  const r = await spawnUntilExit('server.mjs', {
    PORT: '8798',
    MEMORY_LANE_LIBRARY: 'E:/MAYA_BULK/memory-lane-live/../other-tenant'
  });
  assert.equal(r.code, 78, `expected exit 78, got ${r.code}; stderr: ${r.stderr}`);
  assert.match(r.stderr, /refusing to start/);
  assert.match(r.stderr, /traversal/);
});

test('server.mjs refuses a path outside MEMORY_LANE_LIBRARY_ALLOWLIST (exit 78)', async () => {
  const r = await spawnUntilExit('server.mjs', {
    PORT: '8798',
    MEMORY_LANE_LIBRARY: 'C:/definitely/not/allowlisted',
    MEMORY_LANE_LIBRARY_ALLOWLIST: 'E:/MAYA_BULK/memory-lane-live'
  });
  assert.equal(r.code, 78, `expected exit 78, got ${r.code}; stderr: ${r.stderr}`);
  assert.match(r.stderr, /escapes every allowlisted root/);
});

test('MCP bridge refuses traversal MEMORY_LANE_LIBRARY the same way (exit 78)', async () => {
  const r = await spawnUntilExit(path.join('tools', 'memory-lane-mcp.mjs'), {
    MEMORY_LANE_LIBRARY: '../other-tenant'
  });
  assert.equal(r.code, 78, `expected exit 78, got ${r.code}; stderr: ${r.stderr}`);
  assert.match(r.stderr, /refusing to start/);
});

test('server.mjs boots normally with an allowlisted legitimate library', async () => {
  const PORT = 8797;
  const BASE = `http://127.0.0.1:${PORT}`;
  const server = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], {
    env: {
      ...process.env,
      PORT: String(PORT),
      MEMORY_LANE_LIBRARY: path.join(ROOT, 'sample-library'),
      MEMORY_LANE_LIBRARY_ALLOWLIST: ROOT
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stderr = '';
  server.stderr.on('data', (d) => { stderr += String(d); });
  try {
    // wait for the server to accept connections
    const deadline = Date.now() + 8000;
    let up = false;
    while (Date.now() < deadline) {
      try {
        const r = await fetch(`${BASE}/api/status`);
        if (r.ok) { up = true; break; }
      } catch { /* not up yet */ }
      await new Promise((r) => setTimeout(r, 150));
    }
    assert.equal(up, true, `server did not come up; stderr: ${stderr}`);
    const status = await (await fetch(`${BASE}/api/status`)).json();
    assert.equal(status.ok, true);
    // sample library ships with blocks — proves the legit path still loads
    assert.ok(status.stats.totalBlocks > 0, 'sample library should have blocks');
  } finally {
    server.kill();
  }
});
