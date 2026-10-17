import fs from 'node:fs';
import crypto from 'node:crypto';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function fileMatches(file, expected) {
  if (!fs.existsSync(file) || fs.statSync(file).size !== expected.bytes) return false;
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex') === expected.sha256;
}

/** Bounded range requests avoid restarting a large model after a connection
 * drops. The managed partial survives interruption; only a verified file wins. */
export async function verifiedDownload(url, target, expected, options = {}) {
  if (await fileMatches(target, expected)) return;
  const partial = target + '.setup-download', lock = partial + '.lock';
  let descriptor;
  try { descriptor = fs.openSync(lock, 'wx', 0o600); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const pid = Number(fs.readFileSync(lock, 'utf8'));
    if (!Number.isInteger(pid) || pid <= 0) throw new Error('Invalid download lock: ' + lock);
    let alive = true;
    try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') alive = false; }
    if (alive) throw new Error('Another setup process is downloading this model.');
    fs.unlinkSync(lock);
    descriptor = fs.openSync(lock, 'wx', 0o600);
  }
  fs.writeFileSync(descriptor, String(process.pid));
  try {
    if (fs.existsSync(partial) && (!fs.lstatSync(partial).isFile() || fs.statSync(partial).size > expected.bytes)) throw new Error('Invalid partial download: ' + partial);
    let received = fs.existsSync(partial) ? fs.statSync(partial).size : 0;
    const chunkBytes = options.chunkBytes || 8 * 1024 * 1024;
    const fetcher = options.fetch || fetch;
    let lastProgress = 0;
    while (received < expected.bytes) {
      const end = Math.min(expected.bytes - 1, received + chunkBytes - 1);
      const length = end - received + 1;
      let buffer;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const response = await fetcher(url, { headers: { Range: `bytes=${received}-${end}` }, signal: AbortSignal.timeout(90000) });
          const range = response.headers.get('content-range');
          if (!response.ok || (response.status === 206 ? range !== `bytes ${received}-${end}/${expected.bytes}` : response.status !== 200 || received !== 0 || length !== expected.bytes)) throw new Error('Unexpected model range response (HTTP ' + response.status + ').');
          const chunks = []; let size = 0;
          const reader = response.body?.getReader();
          if (!reader) throw new Error('Empty model response.');
          try {
            for (;;) {
              const part = await reader.read(); if (part.done) break;
              size += part.value.length;
              if (size > length) throw new Error('Model range exceeded its expected size.');
              chunks.push(part.value);
            }
          } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
          if (size !== length) throw new Error('Incomplete model range.');
          buffer = Buffer.concat(chunks); break;
        } catch (error) {
          if (attempt === 2) throw new Error('Model download interrupted. Run setup again to resume: ' + error.message);
          await pause(options.retryDelayMs ?? 1000 * (attempt + 1));
        }
      }
      fs.appendFileSync(partial, buffer, { mode: 0o600 }); received += buffer.length;
      if (Date.now() - lastProgress > 5000 || received === expected.bytes) { options.progress?.(Math.floor(received / expected.bytes * 100)); lastProgress = Date.now(); }
    }
    if (!await fileMatches(partial, expected)) { fs.unlinkSync(partial); throw new Error('Downloaded model failed SHA-256 verification. Run setup to retry.'); }
    fs.renameSync(partial, target);
  } finally { fs.closeSync(descriptor); fs.unlinkSync(lock); }
}
