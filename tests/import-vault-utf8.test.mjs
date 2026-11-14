import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadLibrary, readBlock } from '../lib/memoryLaneCore.js';

const importer = fileURLToPath(new URL('../tools/import-vault.mjs', import.meta.url));
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ml-vault-utf8-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const vault = path.join(root, 'vault'), library = path.join(root, 'library');
  fs.mkdirSync(vault);
  const env = { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, PATH: process.env.PATH,
    TEMP: root, TMP: root, HOME: root, USERPROFILE: root, MEMORY_LANE_JEV_ENABLED: '0' };
  const run = (...args) => spawnSync(process.execPath, [importer, vault, '--library', library, ...args], { encoding: 'utf8', env });
  return { vault, library, run };
}

test('valid UTF-8 with a BOM and non-ASCII text is preserved in the block', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.vault, 'note.md'), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('# Café\n\nRésumé — 東京\n')]));
  const result = f.run(); assert.equal(result.status, 0, result.stderr);
  const lib = loadLibrary(f.library); assert.equal(lib.blocks.length, 1);
  assert.ok(readBlock(lib, lib.blocks[0].lib_id).body.includes('Résumé — 東京'));
});

test('malformed UTF-8 is reported and never sealed as replacement characters', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.vault, 'broken.md'), Buffer.from([0x23, 0x20, 0x4e, 0x6f, 0x74, 0x65, 0x0a, 0xff]));
  const result = f.run(); assert.equal(result.status, 1); assert.match(result.stderr, /broken\.md/);
  assert.equal(loadLibrary(f.library).blocks.length, 0);
  assert.equal(f.run('--quiet').status, 1);
});

test('a malformed note reports partial failure while a valid note is imported', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.vault, 'valid.md'), '# Valid\n\nSynthetic text.\n');
  fs.writeFileSync(path.join(f.vault, 'invalid.txt'), Buffer.from([0x41, 0x42, 0x43, 0xc3, 0x28]));
  const result = f.run(); assert.equal(result.status, 1); assert.match(result.stdout, /1 imported, 0 skipped .* 1 failed/);
  const lib = loadLibrary(f.library); assert.equal(lib.blocks.length, 1);
  assert.ok(readBlock(lib, lib.blocks[0].lib_id).body.includes('Synthetic text.'));
});
