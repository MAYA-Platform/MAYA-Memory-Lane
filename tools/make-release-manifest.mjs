#!/usr/bin/env node
/**
 * Generates PUBLIC_RELEASE_MANIFEST.json — SHA-256 + size for every shipped
 * file in the repository (deterministic, sorted by path). Mirrors the same
 * release-manifest bar used across MAYA-Platform public repos.
 *
 * Usage: node tools/make-release-manifest.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const IGNORE = new Set([
  '.git', 'node_modules', '.hermes', 'tests'
]);
const IGNORE_FILES = new Set([
  'PUBLIC_RELEASE_MANIFEST.json'
]);

function walk(dir, base = '') {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (IGNORE.has(entry.name)) continue;
    const rel = path.join(base, entry.name);
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walk(abs, rel));
    } else if (!IGNORE_FILES.has(entry.name)) {
      out.push(rel);
    }
  }
  return out;
}

const files = walk(ROOT).sort();
const entries = {};
let totalBytes = 0;
for (const rel of files) {
  const abs = path.join(ROOT, rel);
  const buf = fs.readFileSync(abs);
  const norm = rel.replace(/\\/g, '/');
  entries[norm] = {
    sha256: crypto.createHash('sha256').update(buf).digest('hex'),
    size: buf.length
  };
  totalBytes += buf.length;
}

const manifest = {
  version: '1.0',
  project: 'maya-memory-lane',
  total_entries: files.length,
  total_bytes: totalBytes,
  files: entries
};

fs.writeFileSync(
  path.join(ROOT, 'PUBLIC_RELEASE_MANIFEST.json'),
  JSON.stringify(manifest, null, 2) + '\n'
);
console.log(`✅ Manifest: ${files.length} files, ${totalBytes} bytes → PUBLIC_RELEASE_MANIFEST.json`);
