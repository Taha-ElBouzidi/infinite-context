// node --test tools/brain-server-embed-stuck.test.mjs
// The 2026-11-02 freeze (about 20:32 to 20:43 UTC): SERVER's CPU was saturated by parallel test runs, one embedding took
// 8.9 s, and recall stopped answering for every agent until the brain server was restarted by hand. The embedding ran
// on the server's only thread (onnxruntime-node runs the model synchronously inside process.nextTick), so a slow or
// stuck embedding held every request behind it, /health included, and nothing bounded how long recall waited for it.
// Runs a throwaway brain server (its own modules, plaintext on a spare loopback port, a temp HAVOK_HOME and a temp
// brain folder) with a fake embedding module that blocks its thread forever, at 0 CPU, on any text holding STUCK.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const MODULES = ['brain-server.mjs', 'brain-git-lock.mjs', 'vault-access.mjs', 'recall-core.mjs', 'recall-graph-worker.mjs', 'tailnet-watch.mjs', 'provenance.mjs', 'tokenize.mjs', 'layers-dist.mjs', 'layer-host.mjs', 'recall-turn.mjs', 'release-host.mjs', 'embed-guard.mjs', 'embed-worker.mjs'];
const EMBED_TIMEOUT_MS = 1500;
let root, home, port, child, token;

const freePort = () => new Promise((ok) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function call(method, path, body, timeoutMs) {
  return new Promise((ok) => {
    const data = body === undefined ? '' : JSON.stringify(body);
    const t0 = Date.now();
    const rq = httpRequest({ host: '127.0.0.1', port, path, method, agent: false, headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), connection: 'close' } }, (r) => {
      let t = ''; r.setEncoding('utf8'); r.on('data', (d) => { t += d; });
      r.on('end', () => { let j = null; try { j = JSON.parse(t); } catch { /* not json */ } ok({ status: r.statusCode, body: j, ms: Date.now() - t0 }); });
    });
    rq.on('error', (e) => ok({ status: 0, error: e.message, ms: Date.now() - t0 }));
    rq.setTimeout(timeoutMs, () => rq.destroy(new Error('no answer in ' + timeoutMs + ' ms')));
    rq.end(data);
  });
}

const memory = (slug, description, body) => '---\nname: ' + slug + '\ndescription: ' + description + '\ntype: reference\n---\n\n' + body + '\n';

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'server-embed-stuck-'));
  home = join(root, 'home');
  for (const d of ['tools', 'memory', 'index', 'home']) mkdirSync(join(root, d));
  for (const m of MODULES) if (existsSync(join(HERE, m))) copyFileSync(join(HERE, m), join(root, 'tools', m));
  const slugs = ['reference_creatine_log', 'reference_garden_tomatoes'];
  writeFileSync(join(root, 'memory', slugs[0] + '.md'), memory(slugs[0], 'How the creatine log works', 'Log creatine every morning.'));
  writeFileSync(join(root, 'memory', slugs[1] + '.md'), memory(slugs[1], 'Tomatoes in the garden', 'Water the tomatoes at dusk.'));
  writeFileSync(join(root, 'index', 'keywords.json'), JSON.stringify({
    terms: { creatine: [slugs[0]], log: [slugs[0]], tomatoes: [slugs[1]], garden: [slugs[1]] },
    descriptions: { [slugs[0]]: 'How the creatine log works', [slugs[1]]: 'Tomatoes in the garden' },
  }));
  writeFileSync(join(root, 'index', 'embeddings.json'), JSON.stringify({ slugs, vectors: [[1, 0, 0, 0], [0, 1, 0, 0]] }));
  // Blocks its thread for good on STUCK, the way a starved or wedged native call does: no CPU, no answer, no error.
  writeFileSync(join(root, 'fake-embed.mjs'), [
    'export async function load() {',
    '  return async (text) => {',
    "    if (String(text).includes('STUCK')) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);",
    "    return { data: Float32Array.from(String(text).includes('tomatoes') ? [0, 1, 0, 0] : [1, 0, 0, 0]) };",
    '  };',
    '}',
  ].join('\n'));
  port = await freePort();
  child = spawn(process.execPath, [join(root, 'tools', 'brain-server.mjs'), '--allow-plaintext'], {
    env: { ...process.env, HAVOK_HOME: home, HAVOK_SERVER_PORT: String(port), HAVOK_EMBED_MODULE: join(root, 'fake-embed.mjs'), HAVOK_EMBED_TIMEOUT_MS: String(EMBED_TIMEOUT_MS) },
    windowsHide: true, stdio: 'ignore',
  });
  for (let i = 0; i < 100; i += 1) {
    if (existsSync(join(home, 'havok-server-token')) && (await call('GET', '/health', undefined, 1000)).status === 200) break;
    await sleep(100);
  }
  token = readFileSync(join(home, 'havok-server-token'), 'utf8').trim();
});

after(() => { try { child.kill(); } catch { /* gone */ } rmSync(root, { recursive: true, force: true }); });

test('recall works when the embedder answers', async () => {
  const r = await call('POST', '/recall', { prompt: 'how do I water the tomatoes' }, 10000);
  assert.equal(r.status, 200, JSON.stringify(r));
  assert.equal(r.body.ranked[0].slug, 'reference_garden_tomatoes');
  assert.equal(r.body.note, undefined);
});

test('/health answers while an embedding is stuck, and the stuck recall ends keyword only and says so', async () => {
  const stuck = call('POST', '/recall', { prompt: 'STUCK how is the creatine log kept' }, 20000);
  await sleep(300);
  const h = await call('GET', '/health', undefined, 2000);
  assert.equal(h.status, 200, '/health did not answer while an embedding was stuck: ' + JSON.stringify(h));
  const r = await stuck;
  assert.equal(r.status, 200, 'the stuck recall did not end with an answer: ' + JSON.stringify(r));
  assert.ok(r.ms < EMBED_TIMEOUT_MS + 5000, 'the stuck recall took ' + r.ms + ' ms');
  assert.equal(r.body.ranked[0].slug, 'reference_creatine_log');
  assert.equal(r.body.ranked[0].how, 'keyword');
  assert.match(r.body.note, /keyword only/);
});

test('a stuck /embed ends with an error instead of hanging, and the next embedding works again', async () => {
  const r = await call('POST', '/embed', { text: 'STUCK again' }, 20000);
  assert.equal(r.status, 503, JSON.stringify(r));
  assert.ok(r.ms < EMBED_TIMEOUT_MS + 5000, 'the stuck embed took ' + r.ms + ' ms');
  const ok = await call('POST', '/embed', { text: 'tomatoes' }, 10000);
  assert.equal(ok.status, 200, JSON.stringify(ok));
  assert.deepEqual(ok.body.vector, [0, 1, 0, 0]);
});
