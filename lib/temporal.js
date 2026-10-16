/** Versioned disposable temporal projection. Claims cannot attest themselves. */
import { readBlock } from './memoryLaneCore.js';
import { digest, namespaceOf } from './access.js';

export const TEMPORAL_VERSION = 1;
const STATES = new Set(['historical', 'proposed', 'approved', 'completed', 'verified', 'active', 'revoked', 'superseded', 'unknown']);
const date = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;

/** Only explicit structured assertions are promoted; ordinary prose is not truth. */
export function buildTemporalProjection(library, { authorities = {} } = {}) {
  const events = [], rejected = [];
  for (const entry of library.blocks) {
    const block = readBlock(library, entry.lib_id);
    if (!block?.present || block.sha256 !== entry.sha256) {
      rejected.push({ source_block_id: entry.block_id, reason: 'source_hash_mismatch_or_missing' });
      continue;
    }
    const observed = date(block.fields.timestamp);
    const trust = authorities[entry.sha256] || {};
    const re = /^@temporal\s+(\{[^\n]+\})\s*$/gm;
    let m;
    while ((m = re.exec(block.raw))) {
      let claim;
      try { claim = JSON.parse(m[1]); } catch { rejected.push({ source_block_id: entry.block_id, reason: 'invalid_event_json' }); continue; }
      const effective = date(claim.effective_at || observed);
      if (!observed || !effective || !claim.entity_id || !claim.predicate || !STATES.has(claim.state) || !Object.hasOwn(claim, 'value')) {
        rejected.push({ source_block_id: entry.block_id, reason: 'invalid_event_schema' });
        continue;
      }
      const verified = trust.verified_by && Number.isFinite(trust.authority_level) && trust.authority_level > 0;
      events.push({ event_id: digest(`${block.sha256}:${m.index}`), entity_id: String(claim.entity_id),
        subject: String(claim.subject || claim.entity_id), predicate: String(claim.predicate), value: claim.value,
        state: claim.state === 'verified' && !verified ? 'completed' : claim.state,
        source_block_id: entry.block_id, source_lib_id: entry.lib_id, source_hash: block.sha256,
        source_type: trust.source_type || 'unattested_record', observed_at: observed, effective_at: effective,
        superseded_at: null, supersedes: Array.isArray(claim.supersedes) ? claim.supersedes.map(String) : [],
        authority_level: Math.max(0, Number(trust.authority_level) || 0),
        verification_status: verified ? 'verified' : 'claimed', verified_by: verified ? trust.verified_by : null,
        confidence: verified ? 1 : null, namespace: namespaceOf(block, library.access?.policy || {}),
        lineage: entry.lineage || null, span: { start: m.index, end: m.index + m[0].length, offset_unit: 'utf16' } });
    }
  }
  events.sort((a, b) => a.effective_at.localeCompare(b.effective_at) || a.observed_at.localeCompare(b.observed_at) || a.event_id.localeCompare(b.event_id));
  return { version: TEMPORAL_VERSION, source_version: digest(JSON.stringify(library.blocks.map(b => [b.block_id, b.sha256]))), events, rejected };
}

function canReplace(next, previous) {
  if (next.state === 'proposed' && previous.state !== 'proposed') return false;
  if (previous.verification_status === 'verified' && next.verification_status !== 'verified') return false;
  if (next.authority_level < previous.authority_level) return false;
  if (['approved', 'active', 'revoked'].includes(next.state) && next.verification_status !== 'verified') return false;
  if (previous.state === 'proposed' && next.verification_status === 'verified' && next.state !== 'proposed') return true;
  return next.supersedes.includes(previous.event_id) || next.supersedes.includes(previous.source_block_id);
}

export function temporalState(projection, { entity, predicate = 'status', asOf = new Date().toISOString(), knownAt = asOf } = {}) {
  const at = date(asOf), known = date(knownAt);
  if (projection?.version !== TEMPORAL_VERSION || !Array.isArray(projection.events) || !at || !known) {
    return { current: null, history: [], conflicts: [], unresolved: ['invalid_projection_or_time'] };
  }
  const history = projection.events.filter(e => e.entity_id === entity && e.predicate === predicate && e.effective_at <= at && e.observed_at <= known).map(e => ({ ...e }));
  let current = null;
  const conflicts = [], unresolved = [];
  for (const event of history) {
    if (['unknown', 'superseded', 'historical'].includes(event.state)) { unresolved.push(event.event_id); continue; }
    if (['approved', 'active', 'revoked'].includes(event.state) && event.verification_status !== 'verified') {
      unresolved.push(event.event_id); continue;
    }
    if (!current) { current = event; continue; }
    if (canReplace(event, current)) {
      current.superseded_at = event.effective_at;
      current = event;
    } else if (event.state === 'proposed' && current.state !== 'proposed') {
      unresolved.push(event.event_id);
    } else if (JSON.stringify(event.value) !== JSON.stringify(current.value) || event.state !== current.state) {
      conflicts.push(event);
    }
  }
  const authorized = predicate === 'authorization' && current?.verification_status === 'verified' &&
    ['approved', 'active'].includes(current.state) && !conflicts.length;
  return { current, history, conflicts, unresolved, authorized,
    status: conflicts.length ? 'conflicting' : current ? 'supported' : 'unknown' };
}
