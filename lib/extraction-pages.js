/** Section-aware, deterministic paging; offsets address the original transcript. */
export function candidatePage(transcript, { cursor = 0, limit = 30, maxChars = 400 } = {}) {
  if (!Number.isInteger(cursor) || cursor < 0) throw Error('Invalid extraction cursor');
  const cap = Math.max(1, Math.min(100, Number(limit) || 30));
  const units = collectCandidates(transcript, maxChars);
  const candidates = units.slice(cursor, cursor + cap);
  return { candidates, total: units.length, cursor, next_cursor: cursor + candidates.length < units.length ? cursor + candidates.length : null };
}

function collectCandidates(transcript, maxChars = 400) {
  const text = String(transcript || '');
  const width = Math.max(80, Math.min(1000, Number(maxChars) || 400));
  const units = [], seen = new Set();
  let section = '', offset = 0;
  for (const line of text.split(/(?<=\n)/)) {
    if (/^\s*#{1,6}\s+/.test(line)) { section = line.trim().replace(/^#+\s*/, ''); offset += line.length; continue; }
    const re = /[^.!?\n]+(?:[.!?]+|\n|$)/g;
    let match;
    while ((match = re.exec(line))) {
      let start = offset + match.index;
      const end = start + match[0].length;
      while (start < end) {
        let stop = Math.min(end, start + width);
        if (stop < end) {
          const boundary = text.lastIndexOf(' ', stop);
          if (boundary > start + width / 2) stop = boundary;
        }
        const fragment = text.slice(start, stop);
        const value = fragment.trim();
        const begin = start + fragment.length - fragment.trimStart().length;
        const key = value.toLowerCase().replace(/\s+/g, ' ');
        if (value.length >= 12 && /[A-Za-z]/.test(value) && /\s/.test(value) &&
          !/^(hi|hey|hello|thanks|thank you|ok|okay|bye)\b/i.test(value) && !seen.has(key)) {
          seen.add(key);
          units.push({ text: value, section, start: begin, end: begin + value.length,
            entities: [...new Set(value.match(/\b[A-Z][A-Za-z0-9_-]+\b/g) || [])],
            dates: [...new Set(value.match(/\b\d{4}-\d{2}-\d{2}\b/g) || [])] });
        }
        start = stop;
      }
    }
    offset += line.length;
  }
  return units;
}

/** One bounded ingest batch spans the entire transcript, including its ending. */
export function coverageCandidates(transcript, maxCandidates = 30) {
  const all = collectCandidates(transcript);
  const cap = Math.max(1, Math.min(100, maxCandidates));
  if (all.length <= cap) return all;
  return Array.from({ length: cap }, (_, i) => all[Math.floor(i * (all.length - 1) / Math.max(1, cap - 1))]);
}
