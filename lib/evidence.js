/** Reproducible UTF-16 spans into the sealed raw source, never rewritten text. */
import { tokenizeQuery } from './memoryLaneCore.js';

export function evidenceSpans(block, query, { maxSpans = 3, maxChars = 600 } = {}) {
  const raw = String(block.raw || '');
  const bodyStart = block.body ? raw.lastIndexOf(block.body) : 0;
  const terms = tokenizeQuery(query);
  const passages = [];
  const re = /[^\n.!?]+(?:[.!?]+|\n|$)/g;
  re.lastIndex = Math.max(0, bodyStart);
  let match;
  while ((match = re.exec(raw))) {
    const text = match[0];
    const hits = terms.filter(t => text.toLowerCase().includes(t)).length;
    if (!hits && terms.length) continue;
    const start = match.index + (text.length - text.trimStart().length);
    const end = Math.min(match.index + text.trimEnd().length, start + maxChars);
    if (end > start) passages.push({ start, end, hits });
  }
  passages.sort((a, b) => b.hits - a.hits || a.start - b.start);
  if (!passages.length && block.body) {
    const start = bodyStart + block.body.length - block.body.trimStart().length;
    passages.push({ start, end: Math.min(raw.length, start + maxChars), hits: 0 });
  }
  return passages.slice(0, maxSpans).map(({ start, end }) => ({
    source_block_id: block.block_id, source_hash: block.sha256,
    offset_unit: 'utf16', start, end, text: raw.slice(start, end)
  }));
}

export function sourceEvidence(block, query) {
  const spans = evidenceSpans(block, query);
  return { lib_id: block.lib_id, block_id: block.block_id,
    display_name: block.fields?.display_name || block.canonical_name || block.block_id,
    source_hash: block.sha256, lineage: block.lineage || null,
    excerpt: spans.map(s => s.text).join('\n'), spans };
}

/** Literal lookup requests qualify; natural-language questions need judgment. */
export function exactLookup(query, evidence) {
  const q = query.trim().replace(/^"|"$/g, '').toLowerCase();
  if (!tokenizeQuery(q).length || /[?]/.test(q)) return false;
  if (/^(did|does|is|are|was|were|what|why|how|who|when|where|can|has|have)\b/.test(q)) return false;
  return evidence.spans.some(s => s.text.toLowerCase().includes(q));
}

/** Conservative gate: uncertainty is preserved rather than ranked away. */
export function conflictingEvidence(evidence) {
  const values = evidence.map(e => e.excerpt.toLowerCase());
  const positive = values.some(v => /\b(completed|finished|shipped|verified|approved|authorized|enabled)\b/.test(v));
  const negative = values.some(v => /\b(not completed|unfinished|incomplete|revoked|rejected|disabled|failed|cancelled)\b/.test(v));
  return positive && negative;
}

