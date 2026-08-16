import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

/**
 * Secret-scan contract test.
 *
 * This is the "never again" guard for the 2026-08-16 incident: a live Honcho
 * API key, founder identity (josh-benchmark), internal workspace name
 * (maya-honcho-shadow-eval), and C:/Users/joshu machine paths leaked into the
 * public repo history across several commits. They were purged; this test makes
 * a reintroduction fail `npm test` immediately.
 */

test('no credentials, machine paths, or internal vocab ship in the repo', () => {
  const out = execFileSync('node', ['tools/secret_scan.mjs'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  // secret_scan.mjs exits 0 and prints "clean" on success; non-zero throws here.
  if (!out.includes('clean')) {
    throw new Error('secret_scan did not report clean:\n' + out);
  }
});
