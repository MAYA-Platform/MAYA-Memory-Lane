import crypto from 'node:crypto';
import fs from 'node:fs';

// Include the bytes, not just timestamps or sizes: edits can preserve both.
// The manifest's resolved paths remain the only files this function reads.
function appendEntry(digest, blocks, entry, bytes) {
  digest.update(JSON.stringify([entry.lib_id, entry.block_id, entry.filePath, entry.lineage, entry.canonical_name]));
  if (bytes === null) {
    digest.update(':missing:');
  } else {
    digest.update(String(bytes.length)).update(':').update(bytes);
    blocks.set(entry.lib_id, {
      raw: bytes.toString('utf8'),
      sha256: crypto.createHash('sha256').update(bytes).digest('hex')
    });
  }
}

function missingAsNull(err) {
  if (err.code === 'ENOENT') return null;
  throw err;
}

// Keep concurrent MCP requests from multiplying filesystem pressure. A
// released slot is handed directly to the oldest waiter, if present.
const MAX_ASYNC_READS = 16;
let activeReads = 0;
const readWaiters = [];

function entryIdentity(entry) {
  return JSON.stringify([entry.lib_id, entry.block_id, entry.filePath, entry.lineage, entry.canonical_name, entry.sha256]);
}

async function boundedRead(filePath) {
  if (activeReads >= MAX_ASYNC_READS) await new Promise(resolve => readWaiters.push(resolve));
  else activeReads++;
  try {
    return await fs.promises.readFile(filePath);
  } catch (err) {
    return missingAsNull(err);
  } finally {
    const next = readWaiters.shift();
    if (next) next();
    else activeReads--;
  }
}

export function captureLibrarySnapshot(library) {
  const digest = crypto.createHash('sha256');
  const blocks = new Map();
  for (const entry of library.blocks) {
    let bytes;
    try { bytes = fs.readFileSync(entry.filePath); } catch (err) { bytes = missingAsNull(err); }
    appendEntry(digest, blocks, entry, bytes);
  }
  return { fingerprint: digest.digest('hex'), blocks };
}

// The bounded batches retain the exact same byte fingerprint as the sync path,
// without blocking the event loop while thousands of files are opened serially.
export async function captureLibrarySnapshotAsync(library) {
  const digest = crypto.createHash('sha256');
  const blocks = new Map();
  // Snapshot the route metadata as well as the bytes: this function yields to
  // the event loop while reading, so callers can otherwise mutate a library.
  const entries = library.blocks.map(entry => ({ ...entry }));
  const identities = entries.map(entryIdentity);
  for (let i = 0; i < entries.length; i += MAX_ASYNC_READS) {
    const batch = entries.slice(i, i + MAX_ASYNC_READS);
    const contents = await Promise.all(batch.map(entry => boundedRead(entry.filePath)));
    batch.forEach((entry, n) => appendEntry(digest, blocks, entry, contents[n]));
  }
  if (library.blocks.length !== entries.length || library.blocks.some((entry, i) => entryIdentity(entry) !== identities[i])) {
    throw new Error('Memory library metadata changed during search; reload and retry');
  }
  return { fingerprint: digest.digest('hex'), blocks };
}
