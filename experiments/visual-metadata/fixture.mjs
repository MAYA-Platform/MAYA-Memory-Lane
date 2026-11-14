// In-memory synthetic metadata only; no capture, image handling, disk or network.
const valid = (s, max = 120) => typeof s === 'string' && s.length > 0 && s.length <= max && s.trim() === s;

export function createVisualMetadataFixture(scope) {
  if (!valid(scope)) throw new TypeError('invalid fixture scope');
  let enabled = false;
  const records = new Map(), deleted = new Set(), excluded = new Set();
  const allowed = candidate => enabled && candidate === scope;
  return Object.freeze({
    setOptIn(candidate, value) {
      if (candidate !== scope || typeof value !== 'boolean') return false;
      enabled = value;
      return true;
    },
    add(candidate, item) {
      if (!allowed(candidate) || !item || item.selected !== true || item.source !== 'synthetic' ||
          !valid(item.id) || !valid(item.application) || !valid(item.label, 200) ||
          excluded.has(item.application) || deleted.has(item.id) || records.has(item.id)) return false;
      records.set(item.id, Object.freeze({id:item.id, application:item.application, label:item.label}));
      return true;
    },
    search(candidate, query) {
      if (!allowed(candidate) || !valid(query, 100)) return [];
      const needle = query.toLowerCase();
      return [...records.values()].filter(row => row.label.toLowerCase().includes(needle))
        .map(row => ({...row}));
    },
    remove(candidate, id) {
      if (candidate !== scope || !valid(id)) return false;
      deleted.add(id);
      return records.delete(id);
    },
    exclude(candidate, application) {
      if (candidate !== scope || !valid(application)) return false;
      excluded.add(application);
      for (const [id, row] of records) {
        if (row.application === application) { records.delete(id); deleted.add(id); }
      }
      return true;
    }
  });
}
