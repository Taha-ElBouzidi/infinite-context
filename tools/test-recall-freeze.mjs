// node tools/test-recall-freeze.mjs
// The owner, 2026-10-31: "we need to fix the freeze". After every index change the first recall rebuilt the link graph
// (every memory against every other, 1.8 s for 1,599 memories, 17.7 s measured under load) on the server's only
// thread, so every other request (recall from other machines, vault, memory writes, health) waited behind it.
// This test changes the index version under a running recall and measures how long the thread is blocked.
// Read only: it uses the real brain's index and memories with a fake embedder and a fake version.
import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeRecall } from './recall-core.mjs';

const BRAIN = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MAX_BLOCK_MS = 300;
const BUILD_WAIT_MS = 20000;

const emb = JSON.parse(readFileSync(join(BRAIN, 'index', 'embeddings.json'), 'utf8'));
const probe = Float32Array.from(emb.vectors[0]);
const getEmbedder = async () => async () => ({ data: probe });
let version = 'test-v1';
const indexVersion = () => ({ version, files: {}, memories: emb.slugs.length });
const recall = makeRecall({ brain: BRAIN, getEmbedder, indexVersion });
const ask = () => recall('what does this memory say', ['what does this memory say'], 5, 0, false);

let failed = 0;
const check = (ok, what) => { console.log((ok ? 'ok    ' : 'FAIL  ') + what); if (!ok) failed++; };

const first = await ask();
check(first.length > 0, `first recall returns memories (${first.length})`);

let worst = 0, last = performance.now();
const lag = setInterval(() => { const now = performance.now(); worst = Math.max(worst, now - last - 5); last = now; }, 5);
version = 'test-v2';
const t0 = performance.now();
const during = await ask();
const tookMs = Math.round(performance.now() - t0);
check(during.length > 0, `recall right after an index change still answers (${during.length} memories, ${tookMs} ms)`);
const until = performance.now() + BUILD_WAIT_MS;
while (performance.now() < until && !(recall.snapshotVersion && recall.snapshotVersion() === 'test-v2')) await new Promise((r) => setTimeout(r, 50));
clearInterval(lag);
check(Math.round(worst) <= MAX_BLOCK_MS, `longest block of the thread while the new index is built: ${Math.round(worst)} ms (limit ${MAX_BLOCK_MS})`);
check(typeof recall.snapshotVersion === 'function' && recall.snapshotVersion() === 'test-v2', 'the new index takes over once built');
const after = await ask();
check(JSON.stringify(after.map((h) => h.slug)) === JSON.stringify(first.map((h) => h.slug)), 'same answer from the rebuilt index (same files, so same memories)');
console.log(failed ? `FAILED ${failed}` : 'PASSED');
process.exit(failed ? 1 : 0);
