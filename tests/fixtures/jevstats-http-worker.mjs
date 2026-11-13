import { jevScoreBatch } from '../../lib/jevrank.js';
const pending = [];
globalThis.fetch = () => new Promise(resolve => pending.push(resolve));
await import('../../server.mjs');
const candidate = [{ block_id: 'synthetic', excerpt: 'synthetic' }];
const response = cost => ({ ok:true, json:async () => ({answers:{C0:{score:1}}, usage:{cost}}) });
let requests = [];
process.on('message', async msg => {
  if (msg === 'start') {
    requests = [jevScoreBatch('synthetic',candidate), jevScoreBatch('synthetic',candidate)];
  } else if (msg === 'second-success') {
    pending[1](response(0.25)); await requests[1];
  } else if (msg === 'first-fail') {
    pending[0]({ok:false,status:503}); await requests[0];
  } else if (msg === 'overflow') {
    globalThis.fetch = async () => response(Number.MAX_VALUE);
    await jevScoreBatch('synthetic',candidate); await jevScoreBatch('synthetic',candidate);
  }
  process.send({ done:msg });
});
process.send({ready:true});
