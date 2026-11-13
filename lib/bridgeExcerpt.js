import { readBlock, manifestHashStatus } from './memoryLaneCore.js';

const EXCERPT_CHARS = 320;

/** Return a digest and status from the same read, without throwing on missing files. */
export function excerptBlock(lib, block) {
  let full;
  try {
    full = readBlock(lib, block.lib_id);
  } catch {
    return { excerpt: '', manifest_hash_status: 'read_error' };
  }
  if (!full) return { excerpt: '', manifest_hash_status: 'unavailable' };
  if (!full.present) return { excerpt: '', manifest_hash_status: 'file_missing' };
  const manifest_hash_status = manifestHashStatus(block, full);
  const body = full.body || '';
  const section = /## (Current State|Established Claims|Decisions)\s*\n([\s\S]*?)(?=\n## |\n# |$)/i.exec(body);
  const text = section ? section[2].trim() : body.replace(/^#.*$/gm, '').trim();
  let excerpt = text;
  if (text.length > EXCERPT_CHARS) {
    const cut = text.slice(0, EXCERPT_CHARS);
    excerpt = cut.slice(0, cut.lastIndexOf(' ')) + '…';
  }
  return { excerpt, manifest_hash_status };
}
