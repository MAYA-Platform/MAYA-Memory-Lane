#!/usr/bin/env node
/**
 * Memory Lane — standalone public server.
 *
 * Serves the Memory Lane web UI and its API endpoints with zero dependencies
 * beyond Node's built-in runtime:
 *
 *   GET /                          -> memory-lane.html
 *   GET /api/status                -> library stats + chain verdict
 *   GET /api/blocks                -> block list (manifest order)
 *   GET /api/blocks/:libId         -> one block (frontmatter + body)
 *   GET /api/chain                 -> full SHA-256 chain verification walk
 *   GET /api/search?q=             -> plain-text search across block bodies
 *   GET /api/resume?phrase=        -> resolve a resume phrase
 *   GET /api/export                -> deterministic JSON export of the library
 *
 * The library it reads defaults to ./sample-library (a deterministic demo)
 * and can be pointed at any real Continuity Library via the
 * MEMORY_LANE_LIBRARY environment variable. Files are the source of truth;
 * this server never writes to the library.
 *
 * Usage:
 *   node server.mjs                    # port 8766, sample library
 *   PORT=9000 MEMORY_LANE_LIBRARY=/path/to/library node server.mjs
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadLibrary,
  readBlock,
  verifyChain,
  search,
  resolveResume,
  exportLibrary,
  libraryStats
} from './lib/memoryLaneCore.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const PORT = Number(process.env.PORT || 8766);
const LIBRARY_PATH = path.resolve(process.env.MEMORY_LANE_LIBRARY || path.join(ROOT, 'sample-library'));
const UI_PATH = path.join(ROOT, 'public', 'memory-lane.html');
const IMAGES_DIR = path.join(ROOT, 'public', 'images');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8'
};

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function sendFile(res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
  fs.createReadStream(filePath).pipe(res);
}

function getLibrary() {
  const lib = loadLibrary(LIBRARY_PATH);
  if (!lib.ok) return lib;
  return lib;
}

/**
 * Public library label. When MEMORY_LANE_LIBRARY is unset (the bundled sample),
 * show a relative, machine-agnostic label instead of the absolute path.
 * An externally supplied library is shown as given.
 */
function libraryLabel() {
  if (!process.env.MEMORY_LANE_LIBRARY) return 'sample-library (bundled)';
  const rel = path.relative(ROOT, LIBRARY_PATH);
  return rel && !rel.startsWith('..') ? rel : LIBRARY_PATH;
}

const routes = {
  '/api/status': (req, res) => {
    const lib = getLibrary();
    if (!lib.ok) return sendJson(res, 500, { ok: false, reason: lib.reason });
    const stats = libraryStats(lib);
    const chain = verifyChain(lib);
    sendJson(res, 200, {
      ok: true,
      library: libraryLabel(),
      stats,
      chain: {
        intact: chain.intact,
        status: chain.status,
        total: chain.total,
        okCount: chain.okCount,
        issues: chain.issues,
        hardIssues: chain.hardIssues,
        unchecked: chain.unchecked
      }
    });
  },

  '/api/blocks': (req, res) => {
    const lib = getLibrary();
    if (!lib.ok) return sendJson(res, 500, { ok: false, reason: lib.reason });
    const blocks = lib.blocks
      .slice()
      .sort((a, b) => a.lib_id - b.lib_id)
      .map((b) => ({
        lib_id: b.lib_id,
        block_id: b.block_id,
        canonical_name: b.canonical_name || b.block_id,
        lineage: b.lineage || null,
        shelf: b.shelf,
        status: b.status || 'active',
        sha256: (b.sha256 || '').slice(0, 16),
        prev_block_id: b.prev_block_id || null
      }));
    sendJson(res, 200, { ok: true, count: blocks.length, blocks });
  },

  '/api/chain': (req, res) => {
    const lib = getLibrary();
    if (!lib.ok) return sendJson(res, 500, { ok: false, reason: lib.reason });
    const chain = verifyChain(lib);
    sendJson(res, 200, {
      ok: true,
      intact: chain.intact,
      status: chain.status,
      total: chain.total,
      okCount: chain.okCount,
      issues: chain.issues,
      verifiedRun: chain.verifiedRun,
      blocks: chain.blocks.map((b) => ({
        lib_id: b.lib_id,
        block_id: b.block_id,
        status: b.status,
        present: b.present,
        recordedSha: b.recordedSha ? b.recordedSha.slice(0, 16) : null,
        computedSha: b.computedSha ? b.computedSha.slice(0, 16) : null,
        prevBlockId: b.prevBlockId,
        prevCheck: b.prevCheck
      }))
    });
  },

  '/api/blocks/:libId': (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const m = /^\/api\/blocks\/(\d+)$/.exec(url.pathname);
    if (!m) return sendJson(res, 404, { ok: false, error: 'not found' });
    const libId = Number(m[1]);
    const lib = getLibrary();
    if (!lib.ok) return sendJson(res, 500, { ok: false, reason: lib.reason });
    const block = readBlock(lib, libId);
    if (!block) return sendJson(res, 404, { ok: false, error: `block ${libId} not in library` });
    sendJson(res, 200, {
      ok: true,
      lib_id: block.lib_id,
      block_id: block.block_id,
      present: block.present,
      fields: block.fields || {},
      body: block.body || null,
      sha256: block.sha256 || null,
      reason: block.reason || null
    });
  },

  '/api/search': (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const q = url.searchParams.get('q') || '';
    const lib = getLibrary();
    if (!lib.ok) return sendJson(res, 500, { ok: false, reason: lib.reason });
    const result = search(lib, q);
    sendJson(res, 200, { ok: true, ...result });
  },

  '/api/resume': (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const phrase = url.searchParams.get('phrase') || '';
    const lib = getLibrary();
    if (!lib.ok) return sendJson(res, 500, { ok: false, reason: lib.reason });
    const result = resolveResume(lib, phrase);
    sendJson(res, 200, { ok: true, ...result });
  },

  '/api/export': (req, res) => {
    const lib = getLibrary();
    if (!lib.ok) return sendJson(res, 500, { ok: false, reason: lib.reason });
    const bundle = exportLibrary(lib);
    sendJson(res, 200, bundle);
  }
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  if (pathname.startsWith('/api/')) {
    const handler = routes[pathname];
    if (handler) return handler(req, res);
    // Pattern routes: /api/blocks/:libId
    const blockMatch = /^\/api\/blocks\/(\d+)$/.exec(pathname);
    if (blockMatch) return routes['/api/blocks/:libId'](req, res);
    return sendJson(res, 404, { ok: false, error: 'not found' });
  }

  // Static image assets from public/images
  if (pathname.startsWith('/images/')) {
    const filePath = path.join(IMAGES_DIR, path.basename(pathname));
    if (fs.existsSync(filePath)) return sendFile(res, filePath);
    return sendJson(res, 404, { ok: false, error: 'image not found' });
  }

  if (pathname === '/' || pathname === '/index.html') {
    if (!fs.existsSync(UI_PATH)) return sendJson(res, 500, { ok: false, error: 'UI missing' });
    return sendFile(res, UI_PATH);
  }

  sendJson(res, 404, { ok: false, error: 'not found' });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Memory Lane running at http://127.0.0.1:${PORT}`);
  console.log(`Library: ${LIBRARY_PATH}`);
  if (process.env.MEMORY_LANE_LIBRARY) {
    console.log('(pointed at external library via MEMORY_LANE_LIBRARY)');
  } else {
    console.log('(default sample library — set MEMORY_LANE_LIBRARY to use your own)');
  }
});
