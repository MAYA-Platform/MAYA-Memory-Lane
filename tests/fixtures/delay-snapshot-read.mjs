import fs from 'node:fs';

// Force a predictable interleaving in the local HTTP integration test.
const readFile = fs.promises.readFile;
fs.promises.readFile = async function (file, ...options) {
  if (typeof file === 'string' && file.endsWith('.md')) {
    if (process.send) process.send({type: 'snapshot-read'});
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  return readFile.call(this, file, ...options);
};
