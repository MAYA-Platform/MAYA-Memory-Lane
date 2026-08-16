#!/usr/bin/env node
/**
 * Memory Lane — secret scanner (pre-release gate).
 *
 * Scans the tracked working tree for hardcoded credential patterns and
 * machine/user paths that must never ship in a public repo. This is the
 * enforcement layer behind the 2026-08-16 incident where a live Honcho API key
 * and founder identity leaked into git history across several commits.
 *
 * Run directly:
 *   node tools/secret_scan.mjs
 *
 * Also wired into the test suite (tests/secret-scan.test.mjs) so `npm test`
 * fails the build on any hit. This is the "never again" guarantee: a commit
 * that reintroduces a key or a machine path cannot pass the test gate.
 *
 * Exit 0 = clean. Exit 1 = findings printed (one per line).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// --- Credential patterns (prefix-based, never the full key) ---
const SECRET_PATTERNS = [
  { name: 'Honcho API key', re: /hch-v3-[A-Za-z0-9]{16,}/ },
  { name: 'OpenAI-style key', re: /\bsk-[A-Za-z0-9]{20,}/ },
  { name: 'Merge Gateway key', re: /mg_l_[A-Za-z0-9]{16,}/ },
  { name: 'Google API key', re: /AIza[0-9A-Za-z_-]{30,}/ },
  { name: 'HuggingFace token', re: /hf_[A-Za-z0-9]{20,}/ },
  { name: 'xAI key', re: /xai-[A-Za-z0-9]{16,}/ },
  { name: 'private key block', re: /BEGIN [A-Z ]*PRIVATE KEY/ },
];

// --- Machine / user paths that must not ship ---
const PATH_PATTERNS = [
  { name: 'Windows user path', re: /C:\\Users\\[A-Za-z0-9]+/ },
  { name: 'Windows user path (fwd)', re: /C:\/Users\/[A-Za-z0-9]+\// },
  { name: 'AppData path', re: /AppData\\Local/ },
  { name: 'OneDrive path', re: /OneDrive\\/ },
  { name: 'founder name', re: /\bjoshuadavidfairbank\b/i },
  { name: 'founder first name (as identity)', re: /\bjosh-benchmark\b/i },
];

// --- Internal stack vocab that must not appear in public prose/code ---
const VOCAB_PATTERNS = [
  { name: 'Merge Gateway brand', re: /merge gateway|merge\.dev|mg_l_|custom_merge/i },
  { name: 'Hermes config coupling', re: /HERMES_HOME.*config\.yaml|providers\.deepseek.*config\.yaml/ },
  { name: 'internal workspace', re: /maya-honcho-shadow-eval|shadow-eval/i },
];

const ALL = [...SECRET_PATTERNS, ...PATH_PATTERNS, ...VOCAB_PATTERNS];

// Text files we scan (skip binaries, images, lockfiles).
const TEXT_EXT = new Set(['.py', '.mjs', '.js', '.md', '.html', '.json', '.jsonl', '.txt', '.yaml', '.yml', '.toml', '.csv', '.ts', '.tsx']);

function trackedFiles() {
  let out = '';
  try {
    out = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' });
  } catch {
    return [];
  }
  return out.split('\0').filter(Boolean);
}

// The scanner's own source and its contract test legitimately contain the
// detection patterns and a description of the incident. Exclude them so the
// guard doesn't flag its own definition.
const SKIP_FILES = new Set([
  'tools/secret_scan.mjs',
  'tests/secret-scan.test.mjs',
]);

function scan() {
  const findings = [];
  for (const rel of trackedFiles()) {
    if (SKIP_FILES.has(rel)) continue;
    const ext = path.extname(rel).toLowerCase();
    if (!TEXT_EXT.has(ext)) continue;
    const abs = path.join(ROOT, rel);
    let text;
    try {
      const buf = fs.readFileSync(abs);
      if (buf.includes(0)) continue; // binary
      text = buf.toString('utf8');
    } catch {
      continue;
    }
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      for (const p of ALL) {
        if (p.re.test(line)) {
          findings.push(`${rel}:${i + 1}: ${p.name}`);
        }
      }
    }
  }
  return findings;
}

const findings = scan();
if (findings.length) {
  console.error('SECRET SCAN FAILED — the following must not ship in a public repo:');
  for (const f of findings) console.error('  ' + f);
  process.exit(1);
}
console.log('Secret scan clean: no credentials, machine paths, or internal vocab in tracked files.');
process.exit(0);
