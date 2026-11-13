import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { verifyChain } from '../lib/memoryLaneCore.js';

const hash = (s) => crypto.createHash('sha256').update(s).digest('hex');

test('verifyChain prioritizes own integrity failures across predecessor states', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ml-chain-priority-'));
  try {
    const prevPath = path.join(dir, 'prev.md');
    const ownPath = path.join(dir, 'own.md');
    fs.writeFileSync(prevPath, 'synthetic predecessor');
    fs.writeFileSync(ownPath, 'synthetic record');
    const prev = { lib_id: 1, block_id: 'prev', filePath: prevPath, sha256: hash('synthetic predecessor') };
    for (const own of ['valid', 'mismatched', 'missing']) {
      for (const link of ['valid', 'unchecked', 'mismatched', 'missing']) {
        if (own === 'missing') fs.rmSync(ownPath, { force: true });
        else fs.writeFileSync(ownPath, 'synthetic record');
        const entry = {
          lib_id: 2, block_id: 'own', filePath: ownPath,
          sha256: hash(own === 'mismatched' ? 'other content' : 'synthetic record'),
          prev_block_id: link === 'missing' ? 'unknown' : 'prev',
          prev_sha256: link === 'unchecked' ? null : hash(link === 'mismatched' ? 'wrong predecessor' : 'synthetic predecessor')
        };
        const chain = verifyChain({ blocks: [prev, entry] });
        const result = chain.blocks[1];
        const expected = own !== 'valid' ? 'hash_mismatch' : link === 'valid' ? 'ok' : link === 'unchecked' ? 'unchecked' : 'link_issue';
        assert.equal(result.status, expected, `${own}/${link} block status`);
        assert.equal(result.prevCheck.status, link === 'valid' ? 'ok' : link === 'unchecked' ? 'unchecked' : link === 'missing' ? 'missing' : 'mismatch', `${own}/${link} predecessor detail`);
        assert.equal(chain.status, expected === 'ok' ? 'intact' : expected === 'unchecked' ? 'unchecked' : 'issues', `${own}/${link} overall status`);
        assert.equal(chain.hardIssues, expected === 'hash_mismatch' || expected === 'link_issue' ? 1 : 0, `${own}/${link} hard issues`);
        assert.equal(chain.unchecked, expected === 'unchecked' ? 1 : 0, `${own}/${link} unchecked count`);
        assert.equal(chain.issues, expected === 'ok' ? 0 : 1, `${own}/${link} issue count`);
      }
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
