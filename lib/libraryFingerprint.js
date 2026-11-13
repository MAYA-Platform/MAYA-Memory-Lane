import crypto from 'node:crypto';
import fs from 'node:fs';

// Include the bytes, not just timestamps or sizes: edits can preserve both.
// The manifest's resolved paths remain the only files this function reads.
export function captureLibrarySnapshot(library) {
  const digest = crypto.createHash('sha256');
  const blocks = new Map();
  for (const entry of library.blocks) {
    digest.update(JSON.stringify([entry.lib_id, entry.block_id, entry.filePath, entry.lineage, entry.canonical_name]));
    try {
      const bytes = fs.readFileSync(entry.filePath);
      digest.update(String(bytes.length)).update(':').update(bytes);
      blocks.set(entry.lib_id, { raw: bytes.toString('utf8') });
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      digest.update(':missing:');
    }
  }
  return { fingerprint: digest.digest('hex'), blocks };
}
