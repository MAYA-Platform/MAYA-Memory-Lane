// Offline comparison; pass an absolute Memory Lane checkout path.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {performance} from 'node:perf_hooks';

const checkout = process.argv[2];
if (!checkout || !path.isAbsolute(checkout)) throw new Error('supply absolute checkout path');
const {loadLibrary, search} = await import(pathToFileURL(path.join(checkout, 'lib/memoryLaneCore.js')));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ml-synthetic-scan-'));
try {
  const dir = path.join(root,'shelves','one'); fs.mkdirSync(dir,{recursive:true});
  const blocks = [];
  for (let i=1; i<=3000; i++) {
    const filename = `${i}.md`;
    fs.writeFileSync(path.join(dir,filename), `${i === 1 ? 'hiking ' : ''}${'synthetic unrelated filler '.repeat(35)}`);
    blocks.push({lib_id:i, block_id:`fixture-${i}`, shelf:'one', filename});
  }
  fs.writeFileSync(path.join(root,'MANIFEST.json'),JSON.stringify({blocks}));
  const library = loadLibrary(root);
  search(library,'hiking',{limit:25,infix:true}); // Warm index and filesystem cache.
  const times = [], cpuStart = process.cpuUsage();
  for (let i=0; i<5; i++) {
    const start = performance.now();
    const result = search(library,'hiking',{limit:25,infix:true});
    if (result.count !== 1) throw new Error(`unexpected fixture count: ${result.count}`);
    times.push(Number((performance.now()-start).toFixed(1)));
  }
  const cpu = process.cpuUsage(cpuStart);
  console.log(JSON.stringify({blocks:blocks.length, repeats:times.length, wallMs:times,
    cpuMs:Number(((cpu.user+cpu.system)/1000).toFixed(1)), peakRssKiB:process.resourceUsage().maxRSS}));
} finally {
  fs.rmSync(root,{recursive:true,force:true});
}
