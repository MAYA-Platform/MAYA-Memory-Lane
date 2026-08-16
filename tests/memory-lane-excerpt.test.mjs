import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadLibrary, readBlock } from '../lib/memoryLaneCore.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE = path.resolve(__dirname, '..', 'sample-library');

/**
 * The excerpt helper in tools/memory-lane-mcp.mjs is a local (non-exported)
 * function. These tests pin the contract it depends on: readBlock exposes the
 * block body, and the section-preference extraction picks Current State /
 * Established Claims / Decisions over the title.
 */

const SECTION_RE = /## (Current State|Established Claims|Decisions)\s*\n([\s\S]*?)(?=\n## |\n# |$)/i;

function excerptText(body) {
  const section = SECTION_RE.exec(body);
  const text = section ? section[2].trim() : body.replace(/^#.*$/gm, '').trim();
  if (!text) return '';
  const cap = 320;
  if (text.length <= cap) return text;
  const cut = text.slice(0, cap);
  return cut.slice(0, cut.lastIndexOf(' ')) + '…';
}

test('readBlock returns the body so a content excerpt can be produced', () => {
  const lib = loadLibrary(SAMPLE);
  const last = lib.blocks[lib.blocks.length - 1];
  const full = readBlock(lib, last.lib_id);
  assert.equal(full.present, true);
  assert.ok(full.body.length > 0);
  assert.ok(full.body.length > full.block_id.length, 'body carries prose, not just the title');
});

test('excerpt extraction returns leading body text when no section header is present', () => {
  const lib = loadLibrary(SAMPLE);
  const last = lib.blocks[lib.blocks.length - 1];
  const excerpt = excerptText(readBlock(lib, last.lib_id).body);
  assert.ok(excerpt.length > 0);
  assert.ok(excerpt.length > last.block_id.length);
});

test('excerpt extraction prefers the Current State section over the title', () => {
  const body = [
    '# Excerpt Test',
    '',
    '## Current State',
    'Complete. The excerpt should prefer this exact sentence over the title.',
    '',
    '## Established Claims',
    'Some claim that should not win because Current State comes first.',
  ].join('\n');
  const excerpt = excerptText(body);
  assert.ok(excerpt.includes('excerpt should prefer this exact sentence'));
  assert.ok(!excerpt.includes('Some claim that should not win'));
});

test('excerpt extraction bounds long content and appends an ellipsis', () => {
  const body = '## Current State\n' + 'word '.repeat(200);
  const excerpt = excerptText(body);
  assert.ok(excerpt.length <= 321);
  assert.ok(excerpt.endsWith('…'));
});

test('excerpt extraction returns empty string for a body with no content', () => {
  assert.equal(excerptText('# Title Only\n\n'), '');
});
