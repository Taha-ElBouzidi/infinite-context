// Builds recall's link graph and first-name contact map on a worker thread (tools/recall-core.mjs starts it).
//
// The owner, 2026-10-31: "we need to fix the freeze". On the main thread this work (every memory against every other,
// 1.8 s for 1,599 memories, 17.7 s measured under load) blocked every request the brain server had, after every
// index change. Same rules as before, moved, not rewritten: a hand [[link]] weighs 1, and each memory links to its
// MEANING_K nearest neighbours whose match is at least MEANING_FLOOR; the larger weight wins, both directions.
import { parentPort, workerData } from 'node:worker_threads';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const { brain, slugs, dim, vectors, meaningK, meaningFloor } = workerData;
const n = slugs.length;
const at = new Map(slugs.map((s, i) => [s, i]));
const g = Array.from({ length: n }, () => new Map());
const link = (i, j, w) => { if (i === j) return; g[i].set(j, Math.max(g[i].get(j) || 0, w)); g[j].set(i, Math.max(g[j].get(i) || 0, w)); };

const contacts = new Map();
for (const s of slugs) {
  let text = '';
  try { text = readFileSync(join(brain, 'memory', s + '.md'), 'utf8'); } catch { continue; }
  for (const m of text.matchAll(/\[\[([a-z0-9_-]+)\]\]/g)) { const j = at.get(m[1]); if (j !== undefined) link(at.get(s), j, 1); }
  if (s.startsWith('contact_')) {
    const nm = (text.match(/^name:\s*(.*)$/m) || [])[1] || '';
    const first = (nm.replace(/^contact_/, '').split(/[\s,_-]+/)[0] || '').toLowerCase();
    if (first.length >= 3) contacts.set(first, (contacts.get(first) || []).concat([s]));
  }
}

for (let i = 0; i < n; i++) {
  const sims = [];
  for (let j = 0; j < n; j++) {
    if (j === i) continue;
    let d = 0;
    for (let k = 0; k < dim; k++) d += vectors[i * dim + k] * vectors[j * dim + k];
    sims.push([j, d]);
  }
  sims.sort((a, b) => b[1] - a[1]);
  for (const [j, d] of sims.slice(0, meaningK)) if (d >= meaningFloor) link(i, j, d);
}

let edges = 0;
for (const m of g) edges += m.size;
const from = new Int32Array(edges), to = new Int32Array(edges), weight = new Float64Array(edges);
let e = 0;
for (let i = 0; i < n; i++) for (const [j, w] of g[i]) { from[e] = i; to[e] = j; weight[e] = w; e++; }
parentPort.postMessage({ from, to, weight, contacts: [...contacts] }, [from.buffer, to.buffer, weight.buffer]);
