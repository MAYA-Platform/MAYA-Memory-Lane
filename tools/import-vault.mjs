#!/usr/bin/env node
/**
 * Memory Lane vault import (2026-09-06).
 *
 * Point Memory Lane at an existing folder of markdown notes (an Obsidian
 * vault, a docs tree, a pile of session logs) and import every note as a
 * chain-linked memory block. This is the missing on-ramp: the library
 * engine expects Memory Lane's own on-disk format, so an existing vault
 * directory cannot be used as a library directly. This tool bridges that
 * instead of asking the vault to change shape.
 *
 * Behavior:
 *   - Creates the target library if it does not exist yet (fresh MANIFEST).
 *   - Walks the source folder for .md / .txt files (skips .obsidian, .git,
 *     node_modules, hidden dot-folders, and anything over --max-kb).
 *   - Each file becomes one block: title from the first heading or filename,
 *     body = the note text. Facts are left empty by default (LLM extraction
 *     is opt-in via --extract, see README "How extraction works").
 *   - The raw text is sealed and fully searchable either way: FTS5 indexes
 *     the whole body, not just facts.
 *   - Dedup is automatic: re-running the import skips already-imported
 *     files (stable content fingerprint), so it is safe to re-run as the
 *     vault grows.
 *
 * Usage:
 *   node tools/import-vault.mjs <vault-folder> [--library <library-dir>]
 *        [--max-kb 200] [--extract] [--source "obsidian vault"]
 *
 * Default library: the library the server uses (MEMORY_LANE_LIBRARY env, or
 * ./empty-library next to the repo).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendBlock } from '../lib/memoryLaneCore.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

const DEFAULT_LIBRARY = process.env.MEMORY_LANE_LIBRARY
  || path.join(REPO_ROOT, 'empty-library');

const SKIP_DIRS = new Set(['.obsidian', '.git', '.trash', 'node_modules', '.smart-env', '.space', '_files']);
const EXTS = new Set(['.md', '.txt']);
const MAX_FILES_DEFAULT = 5000;
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function sha256ish(text) {
  // Cheap local fingerprint for run-to-run dedup of import offers. Real
  // block integrity stays with appendBlock()'s SHA-256 chain.
  let h = 0;
  for (let i = 0; i < text.length; i++) {
    h = (h * 31 + text.charCodeAt(i)) | 0;
  }
  return String(h);
}

function sourceLineage(vault, file) {
  const rel = path.relative(vault, file).replace(/\\/g, '/');
  return 'vault_' + sha256ish(vault + '|' + rel);
}

function parseArgs(argv) {
  const opts = {
    vault: null,
    library: DEFAULT_LIBRARY,
    maxKb: 200,
    extract: false,
    source: 'vault-import',
    quiet: false
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--library') opts.library = path.resolve(argv[++i]);
    else if (a === '--max-kb') opts.maxKb = Number(argv[++i]);
    else if (a === '--extract') opts.extract = true;
    else if (a === '--source') opts.source = argv[++i];
    else if (a === '--quiet') opts.quiet = true;
    else if (!a.startsWith('--')) opts.vault = path.resolve(a);
  }
  return opts;
}

/** Recursively collect candidate note files. */
function collectFiles(dir, state, depth = 0) {
  if (state.truncated) return;
  if (depth > 12) {
    state.errors.push(`maximum directory depth exceeded: ${dir}`);
    return;
  }
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    state.errors.push(`cannot read directory ${dir}: ${err.message}`);
    return;
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue; // hidden files AND dot-folders
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      collectFiles(full, state, depth + 1);
    } else if (e.isFile() && EXTS.has(path.extname(e.name).toLowerCase())) {
      if (state.files.length >= MAX_FILES_DEFAULT) {
        state.errors.push(`maximum candidate count exceeded (${MAX_FILES_DEFAULT})`);
        state.truncated = true;
        return;
      }
      state.files.push(full);
    }
    if (state.truncated) return;
  }
}

/** Title = first markdown heading, else filename. */
function deriveTitle(text, filePath) {
  const m = String(text).match(/^#\s+(.{3,120})\s*$/m);
  if (m) return m[1].trim();
  return path.basename(filePath, path.extname(filePath));
}

/** Build a fresh, valid empty MANIFEST for a brand-new library dir. */
function initLibrary(rootDir) {
  const manifestPath = path.join(rootDir, 'MANIFEST.json');
  if (fs.existsSync(manifestPath)) return;
  fs.mkdirSync(path.join(rootDir, 'shelves'), { recursive: true });
  const manifest = {
    library: 'memory-lane-imported',
    version: '1.0.0',
    schema_version: '1.0',
    schema_description: 'A Memory Lane library created by vault import. Records appear here as notes and sessions are sealed.',
    created: new Date().toISOString(),
    updated: 0,
    total_blocks: 0,
    total_shelves: 0,
    volumes: [],
    shelves: [],
    blocks: [],
    lineages: {}
  };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.vault || !fs.existsSync(opts.vault)) {
    console.error('Usage: node tools/import-vault.mjs <vault-folder> [--library <dir>] [--max-kb 200] [--extract]');
    process.exit(2);
  }
  if (!Number.isFinite(opts.maxKb) || opts.maxKb <= 0) {
    console.error('--max-kb must be a finite positive number');
    process.exit(2);
  }

  const scan = { files: [], errors: [], truncated: false };
  collectFiles(opts.vault, scan);
  const files = scan.files;
  const lineages = new Set();
  for (const file of files) {
    const lineage = sourceLineage(opts.vault, file);
    if (lineages.has(lineage)) {
      console.error('vault import blocked: source paths share a legacy lineage; no library changes made');
      process.exitCode = 1;
      return;
    }
    lineages.add(lineage);
  }
  if (!opts.quiet) {
    console.log(`vault import: ${files.length} candidate file(s) under ${opts.vault}`);
    console.log(`target library: ${opts.library}`);
    for (const error of scan.errors) console.error(`  ! ${error}`);
  }

  initLibrary(opts.library);

  let imported = 0;
  let skipped = 0;
  let failed = scan.errors.length;

  for (const file of files) {
    let text;
    try {
      if (fs.statSync(file).size > opts.maxKb * 1024) { skipped++; continue; }
      const bytes = fs.readFileSync(file);
      if (bytes.length > opts.maxKb * 1024) { skipped++; continue; }
      // Refuse malformed bytes rather than sealing a silently altered note.
      text = UTF8_DECODER.decode(bytes);
    } catch (err) {
      failed++;
      if (!opts.quiet) console.error(`  ! ${file}: ${err.message}`);
      continue;
    }
    const body = text.trim();
    if (body.length < 3) { skipped++; continue; }
    const title = deriveTitle(text, file);
    // Deterministic lineage per source vault keeps the chain grouped and
    // makes re-runs dedupe cleanly (dedup key includes lineage).
    const rel = path.relative(opts.vault, file).replace(/\\/g, '/');
    const lineage = sourceLineage(opts.vault, file);

    try {
      const result = appendBlock(opts.library, {
        title,
        body,
        facts: [],
        source: opts.source,
        lineage
      });
      if (result?.ok && result.skipped) {
        skipped++;
        if (!opts.quiet) console.log(`  = ${rel} -> already imported`);
      } else if (result?.ok) {
        imported++;
        if (!opts.quiet) console.log(`  + ${rel} -> ${result.block_id || 'ok'}`);
      } else {
        failed++;
        if (!opts.quiet) console.error(`  ! ${rel}: ${result?.reason || 'append failed'}`);
      }
    } catch (err) {
      failed++;
      if (!opts.quiet) console.error(`  ! ${rel}: ${err && err.message ? err.message : err}`);
    }
  }

  if (!opts.quiet) {
    console.log(`done: ${imported} imported, ${skipped} skipped (dup/empty/oversize), ${failed} failed`);
    if (imported > 0) {
      console.log(`open the interface and search, or point MEMORY_LANE_LIBRARY at ${opts.library}`);
    }
  }
  process.exitCode = failed ? 1 : 0;
}

main();
