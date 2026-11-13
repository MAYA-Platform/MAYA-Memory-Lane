import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

test('a stalled Jev response body times out and preserves search results', async (t) => {
  const oldUrl = process.env.MEMORY_LANE_DECISIONS_URL;
  const oldKey = process.env.MERGE_API_KEY;
  let responseTimer;
  const server = http.createServer((req, res) => {
    req.resume();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.flushHeaders();
    // The base implementation stops the deadline after headers and accepts
    // this late response. A real timeout should abort while reading the body.
    responseTimer = setTimeout(() => res.end(JSON.stringify({ answers: {
      C0: { score: 0 }, C1: { score: 2 }
    } })), 4000);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    clearTimeout(responseTimer);
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    if (oldUrl === undefined) delete process.env.MEMORY_LANE_DECISIONS_URL;
    else process.env.MEMORY_LANE_DECISIONS_URL = oldUrl;
    if (oldKey === undefined) delete process.env.MERGE_API_KEY;
    else process.env.MERGE_API_KEY = oldKey;
  });
  process.env.MEMORY_LANE_DECISIONS_URL = `http://127.0.0.1:${server.address().port}/decisions`;
  process.env.MERGE_API_KEY = 'synthetic-test-key';
  const { jevRank, jevStats } = await import('../lib/jevrank.js?response-timeout-test');
  const matches = [
    { lib_id: 1, block_id: 'one', excerpt: 'one' },
    { lib_id: 2, block_id: 'two', excerpt: 'two' }
  ];
  const before = jevStats();
  const result = await jevRank({ blocks: [] }, 'search', matches);
  assert.deepEqual(result.matches, matches);
  assert.equal(result.jev.applied, false);
  assert.equal(result.jev.reason, 'timeout >3000ms');
  assert.equal(jevStats().timeouts, before.timeouts + 1);
  assert.equal(jevStats().failures, before.failures + 1);
});
