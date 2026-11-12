/** Nonblocking session anchors; all writes use the existing sealed append path. */
import fs from 'node:fs';
import path from 'node:path';
import { appendBlock, loadLibrary, readBlock } from './memoryLaneCore.js';
import { permitted, redactOutbound, digest, auditReceipt } from './access.js';

const FIVE_HOURS = 5 * 60 * 60 * 1000;

export class FreshnessAnchors {
  constructor({ root, principal, namespace, getPolicy, maxQueue = 64, maxAttempts = 3 }) {
    Object.assign(this, { root, principal, namespace, getPolicy });
    this.maxQueue = Math.max(1, Math.min(256, maxQueue));
    this.maxAttempts = Math.max(1, Math.min(5, maxAttempts));
    this.sessions = new Map(); this.queue = []; this.scheduled = false;
    this.queueFile = path.join(root, 'health', `anchors-${digest(`${principal}:${namespace}`).slice(0, 16)}.json`);
    this.ready = false;
  }

  recover() {
    if (this.ready) return;
    if (!permitted(this.getPolicy(), this.principal, this.namespace, 'write')) throw Error('Anchor write access denied');
    const library = loadLibrary(this.root);
    if (!library.ok) throw Error('Anchor library unavailable');
    // State is rebuildable from canonical anchors; pending retries are operational state.
    for (const entry of library.blocks) {
      const block = readBlock(library, entry.lib_id);
      if (!block?.present || block.sha256 !== entry.sha256 || block.fields.namespace !== this.namespace || !block.fields.anchor_type) continue;
      const match = /^@anchor (.+)$/m.exec(block.raw);
      if (!match) continue;
      const anchor = JSON.parse(match[1]);
      const old = this.sessions.get(anchor.session_id);
      if (!old || Date.parse(old.last_active) < Date.parse(anchor.at)) this.sessions.set(anchor.session_id, { last_active: anchor.at, open_id: anchor.open_id || anchor.anchor_id });
    }
    if (fs.existsSync(this.queueFile)) {
      const pending = JSON.parse(fs.readFileSync(this.queueFile, 'utf8'));
      if (pending.version !== 1 || !Array.isArray(pending.queue) || !Array.isArray(pending.sessions)) throw Error('Corrupt anchor queue');
      this.queue = pending.queue.slice(0, this.maxQueue);
      for (const [id, session] of pending.sessions.slice(-1024)) this.sessions.set(id, session);
    }
    this.ready = true;
  }

  persist() {
    fs.mkdirSync(path.dirname(this.queueFile), { recursive: true });
    fs.writeFileSync(this.queueFile + '.tmp', JSON.stringify({ version: 1, queue: this.queue,
      sessions: [...this.sessions.entries()].slice(-1024) }));
    fs.renameSync(this.queueFile + '.tmp', this.queueFile);
  }

  /** Returns immediately. Validation, disk I/O, and retries occur off the caller turn. */
  observe(message) {
    if (this.closed || (this.pendingObservations || 0) >= this.maxQueue) return { queued: false };
    this.pendingObservations = (this.pendingObservations || 0) + 1;
    setImmediate(() => {
      this.pendingObservations--;
      if (this.closed) return;
      try { this.accept(message); } catch (error) { this.receipt({ type: 'anchor_failed', reason: error.message }); }
    });
    return { queued: true };
  }

  receipt(event) {
    try { auditReceipt(this.root, { principal: this.principal, namespace: this.namespace, ...event }); }
    catch (error) { this.lastReceiptFailure = error.message; }
  }

  accept({ sessionId, timestamp, runtime = 'unknown', sketch = '', closeBlockId = null }) {
    this.recover();
    if (!permitted(this.getPolicy(), this.principal, this.namespace, 'write')) throw Error('Anchor write access denied');
    if (!sessionId || !Number.isFinite(Date.parse(timestamp))) throw Error('Invalid anchor session or time');
    const at = new Date(timestamp).toISOString();
    const session = digest(String(sessionId));
    const previous = this.sessions.get(session);
    if (previous && at < previous.last_active) return;
    const gap = previous ? Date.parse(at) - Date.parse(previous.last_active) : 0;
    const type = closeBlockId ? 'CLOSE' : !previous ? 'SESSION_OPEN' : gap >= FIVE_HOURS ? 'WAKE' : null;
    if (!type) { this.sessions.set(session, { ...previous, last_active: at }); this.persist(); return; }
    const anchorId = digest(`${this.namespace}:${session}:${type}:${at}:${closeBlockId || ''}`);
    const anchor = { anchor_id: anchorId, type, session_id: session, at,
      open_id: previous?.open_id || anchorId, runtime: String(runtime).slice(0, 40),
      ...(type === 'SESSION_OPEN' ? { sketch: redactOutbound(sketch).replace(/\s+/g, ' ').slice(0, 160) } : {}),
      ...(type === 'WAKE' ? { last_active: previous.last_active, inactivity_ms: gap } : {}),
      ...(closeBlockId ? { close_block_id: String(closeBlockId) } : {}) };
    if (this.queue.length >= this.maxQueue) throw Error('Anchor queue full');
    this.queue.push({ anchor, attempts: 0 });
    this.sessions.set(session, { last_active: at, open_id: anchor.open_id });
    this.persist();
    this.schedule();
  }

  schedule() {
    if (this.scheduled || this.closed) return;
    this.scheduled = true;
    setImmediate(() => { this.scheduled = false; this.flush(); });
  }

  flush() {
    if (this.closed) return;
    try { this.recover(); } catch (error) { this.receipt({ type: 'anchor_failed', reason: error.message }); return; }
    for (let i = 0; i < this.maxQueue && this.queue.length; i++) {
      const task = this.queue[0];
      try {
        if (!permitted(this.getPolicy(), this.principal, this.namespace, 'write')) throw Error('Anchor write access denied');
        if (!['SESSION_OPEN', 'WAKE', 'CLOSE'].includes(task.anchor?.type)) throw Error('Invalid queued anchor');
        if (task.anchor.type === 'CLOSE') {
          const lib = loadLibrary(this.root);
          const entry = lib.blocks.find(b => b.block_id === task.anchor.close_block_id);
          const block = entry && readBlock(lib, entry.lib_id);
          if (!block?.present || block.sha256 !== entry.sha256 || block.fields.namespace !== this.namespace) throw Error('Invalid close source');
        }
        // A durable permission receipt precedes each attempted write. If audit
        // storage fails, no new memory is written.
        auditReceipt(this.root, { type: 'anchor_write', anchor_id: task.anchor.anchor_id, principal: this.principal, namespace: this.namespace });
        const result = appendBlock(this.root, { title: `${task.anchor.type} ${task.anchor.anchor_id}`,
          body: `@anchor ${JSON.stringify(task.anchor)}`, lineage: 'session-anchors',
          timestamp: task.anchor.at, namespace: this.namespace, anchorType: task.anchor.type });
        if (!result.ok) throw Error(result.reason);
        this.receipt({ type: 'anchor_sealed', anchor_id: task.anchor.anchor_id, source_block_id: result.block_id, source_hash: result.sha256 });
        this.queue.shift();
      } catch (error) {
        task.attempts++;
        this.receipt({ type: 'anchor_failed', anchor_id: task.anchor?.anchor_id, attempt: task.attempts, reason: error.message });
        if (task.attempts >= this.maxAttempts) this.queue.shift();
        else break;
      }
    }
    try { this.persist(); } catch (error) { this.receipt({ type: 'anchor_queue_failed', reason: error.message }); }
    if (this.queue.length) {
      this.timer = setTimeout(() => this.schedule(), 1000);
      this.timer.unref();
    }
  }

  close() { this.closed = true; clearTimeout(this.timer); }
}
