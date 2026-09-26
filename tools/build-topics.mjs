// Groups the brain's memories into named topics and writes index/topics.json.
//
// The link graph (hand wikilinks plus meaning links) is built the same way brain-server.mjs's
// linkGraph does it: top-5 nearest neighbours by cosine, kept only at cosine >= 0.55. That part
// is copied rather than imported so this tool has no runtime dependency on the live server.
// One difference from the server: here a hand link and a meaning link between the same pair
// ADD, they do not take the max. The server wants "how strong is the strongest reason these two
// are related" for spreading activation; a topic wants "how much total pull holds this pair
// together", so a pair that is both hand-linked and semantically close should count more than
// either alone.
//
// Run: node tools/build-topics.mjs           builds and writes index/topics.json
//      node tools/build-topics.mjs --check    builds and prints, writes nothing
//
// Community detection is multilevel Louvain: local moving to modularity convergence, then the
// found communities are collapsed into single nodes (their internal edges becoming a self-loop)
// and the same local moving runs again on that smaller graph. A single level left the graph in
// many small local optima (dozens of communities under 10 members each) because a sparse graph
// like this one has too few cross-links for one pass of local moving to escape them; collapsing
// and re-running is what lets those small optima merge into the graph's real communities.
// Deterministic throughout: nodes are always visited in slug order (or, after the first level,
// in the order their community ids were assigned, which was itself assigned in slug order), and
// every tie (equal modularity gain, equal edge weight) is broken by the lower id, never by
// insertion order or Math.random.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const BRAIN = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MEM = join(BRAIN, 'memory');
const IDX = join(BRAIN, 'index');
const CHECK = process.argv.includes('--check');

const MEANING_K = 5;
const MEANING_FLOOR = 0.55;
const MIN_TOPIC_SIZE = 4;
// Resolution for the Louvain gain formula (Reichardt-Bornholdt). 1.0 is plain modularity, which
// on this brain collapses into a handful of giant components. Raised until the topic count
// landed in the requested 10 to 30 range; see the tuning note printed at the end of main().
const RESOLUTION = 2.5;

const STOP = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'at', 'for', 'with', 'is', 'are', 'was',
  'were', 'be', 'been', 'being', 'that', 'this', 'these', 'those', 'it', 'its', 'as', 'by', 'from',
  'not', 'no', 'so', 'but', 'if', 'when', 'what', 'how', 'why', 'who', 'which', 'memory',
  'memories', 'use', 'used', 'uses', 'using', 'read', 'has', 'have', 'had', 'do', 'does', 'did',
  'about', 'into', 'than', 'then', 'also', 'more', 'most', 'can', 'will', 'would', 'should',
  'could', 'may', 'might', 'must', 'one', 'two', 'over', 'out', 'up', 'down', 'per', 'via', 'etc',
  'own', 'all', 'any', 'each', 'other', 'some', 'such', 'only', 'just', 'still', 'yet', 'both',
  'because', 'while', 'before', 'after', 'between', 'under', 'again', 'i', 's', 'am', 'me', 'my',
  'he', 'she', 'they', 'his', 'her', 'their', 'him', 'them', 'we', 'our', 'you', 'your', 'there',
  // French: a share of the memories are written in French, and 'les' and 'est' were naming a topic.
  'les', 'des', 'est', 'une', 'pour', 'par', 'dans', 'sur', 'pas', 'que', 'qui', 'avec', 'sont', 'aux',
  'ces', 'son', 'ses', 'mais', 'ou', 'du', 'de', 'la', 'le', 'un', 'et', 'en', 'au',
  // Too general to name a topic.
  'sub', 'long', 'new', 'now', 'day', 'last', 'first', 'change', 'value', 'right', 'wrong', 'never', 'always',
]);

function loadJSON(path) { return JSON.parse(readFileSync(path, 'utf8')); }

function buildGraph(slugs, vectors) {
  const n = slugs.length;
  const at = new Map(slugs.map((s, i) => [s, i]));
  const g = Array.from({ length: n }, () => new Map());
  const add = (i, j, w) => {
    if (i === j) return;
    g[i].set(j, (g[i].get(j) || 0) + w);
    g[j].set(i, (g[j].get(i) || 0) + w);
  };
  for (const s of slugs) {
    let text = '';
    try { text = readFileSync(join(MEM, s + '.md'), 'utf8'); } catch { continue; }
    const seen = new Set();
    for (const m of text.matchAll(/\[\[([a-z0-9_-]+)\]\]/g)) {
      const j = at.get(m[1]);
      if (j === undefined) continue;
      const key = j < at.get(s) ? j + ':' + at.get(s) : at.get(s) + ':' + j;
      if (seen.has(key)) continue; // a memory can link the same slug twice in its body
      seen.add(key);
      add(at.get(s), j, 1.0);
    }
  }
  for (let i = 0; i < n; i++) {
    const vi = vectors[i];
    const sims = [];
    for (let j = 0; j < n; j++) {
      if (j === i) continue;
      const vj = vectors[j];
      let d = 0;
      for (let k = 0; k < vi.length; k++) d += vi[k] * vj[k];
      sims.push([j, d]);
    }
    // Sort by cosine desc, then by slug asc so ties never depend on array insertion order.
    sims.sort((a, b) => (b[1] - a[1]) || (slugs[a[0]] < slugs[b[0]] ? -1 : 1));
    for (const [j, d] of sims.slice(0, MEANING_K)) if (d >= MEANING_FLOOR) add(i, j, d);
  }
  return g;
}

// One level of Louvain local moving. `self[i]` is the self-loop weight collapsed into node i by
// an earlier aggregation (0 for the original, uncollapsed graph); it contributes twice to that
// node's degree, the standard convention for a self-loop's share of total degree. Returns an
// Int32Array of community ids (0-based, not necessarily contiguous until relabeled by the caller).
function louvain(g, self, resolution) {
  const n = g.length;
  const comm = new Int32Array(n).map((_, i) => i);
  const degree = new Float64Array(n);
  let m2 = 0; // 2 * total edge weight, including self-loops
  for (let i = 0; i < n; i++) {
    let d = 2 * self[i];
    for (const w of g[i].values()) d += w;
    degree[i] = d;
    m2 += d;
  }
  if (m2 === 0) return comm; // no edges anywhere
  const sigmaTot = Float64Array.from(degree); // sum of degrees per community, indexed by comm id

  // Visit order fixed by node index, which the caller already sorted by slug.
  const order = Array.from({ length: n }, (_, i) => i);
  let improved = true;
  let pass = 0;
  while (improved && pass < 100) {
    improved = false;
    pass++;
    for (const i of order) {
      const ki = degree[i];
      if (ki === 0) continue; // isolated node, nothing to gain by moving
      const oldComm = comm[i];
      // Weight from i into each neighbouring community, and remove i from its own community's total.
      const neighComm = new Map(); // commId -> weight from i
      for (const [j, w] of g[i]) {
        const cj = comm[j];
        neighComm.set(cj, (neighComm.get(cj) || 0) + w);
      }
      sigmaTot[oldComm] -= ki;
      let bestComm = oldComm;
      let bestGain = (neighComm.get(oldComm) || 0) - resolution * sigmaTot[oldComm] * ki / m2;
      // Sort candidate communities by id so equal-gain ties always resolve to the lowest id,
      // never to whichever neighbour happened to be inserted into the Map first.
      const candidates = [...neighComm.keys()].sort((a, b) => a - b);
      for (const c of candidates) {
        const gain = (neighComm.get(c) || 0) - resolution * sigmaTot[c] * ki / m2;
        if (gain > bestGain + 1e-12) { bestGain = gain; bestComm = c; }
      }
      sigmaTot[bestComm] += ki;
      if (bestComm !== oldComm) { comm[i] = bestComm; improved = true; }
    }
  }
  return comm;
}

// Collapses each community found by one level of local moving into a single node of the next
// level's graph. An edge fully inside a community becomes part of that community's self-loop;
// an edge crossing two communities becomes (or adds to) the edge between their two new nodes.
function aggregate(g, self, comm, numComm) {
  const newSelf = new Float64Array(numComm);
  const newAdj = Array.from({ length: numComm }, () => new Map());
  const addEdge = (a, b, w) => {
    newAdj[a].set(b, (newAdj[a].get(b) || 0) + w);
    newAdj[b].set(a, (newAdj[b].get(a) || 0) + w);
  };
  for (let i = 0; i < g.length; i++) {
    newSelf[comm[i]] += self[i];
    for (const [j, w] of g[i]) {
      if (j <= i) continue; // each undirected edge is stored twice (i->j and j->i); count it once
      const ci = comm[i];
      const cj = comm[j];
      if (ci === cj) newSelf[ci] += w; else addEdge(ci, cj, w);
    }
  }
  return { adj: newAdj, self: newSelf };
}

// Runs local moving, then collapses the result and runs it again on the smaller graph, until a
// level produces exactly as many communities as it had nodes (nothing merged, so further levels
// would be a no-op). Returns the ORIGINAL nodes' final community id, found by composing every
// level's local id back down through the chain of aggregations.
function multilevelLouvain(g, resolution, maxLevels) {
  const n = g.length;
  let curAdj = g;
  let curSelf = new Float64Array(n);
  let originalToLevel = Int32Array.from({ length: n }, (_, i) => i);
  for (let level = 0; level < maxLevels; level++) {
    const comm = relabel(louvain(curAdj, curSelf, resolution));
    const numComm = Math.max(...comm) + 1;
    for (let i = 0; i < n; i++) originalToLevel[i] = comm[originalToLevel[i]];
    if (numComm === curAdj.length) break; // converged: this level moved nothing
    const agg = aggregate(curAdj, curSelf, comm, numComm);
    curAdj = agg.adj;
    curSelf = agg.self;
  }
  return Int32Array.from(originalToLevel);
}

function relabel(comm) {
  const map = new Map();
  const out = new Int32Array(comm.length);
  for (let i = 0; i < comm.length; i++) {
    if (!map.has(comm[i])) map.set(comm[i], map.size);
    out[i] = map.get(comm[i]);
  }
  return out;
}

// Merges any community under MIN_TOPIC_SIZE into the neighbouring community it has the most
// total edge weight to. Repeats since a merge can shrink another community below threshold
// only if that community absorbed into it, which cannot happen here (merges only grow), so one
// pass suffices, but the loop guards against the rare chain where a merge target is itself tiny.
function mergeSmall(comm, g, slugs) {
  let changed = true;
  let guard = 0;
  while (changed && guard < 20) {
    changed = false;
    guard++;
    const sizes = new Map();
    for (const c of comm) sizes.set(c, (sizes.get(c) || 0) + 1);
    const small = [...sizes.entries()].filter(([, sz]) => sz < MIN_TOPIC_SIZE).map(([c]) => c).sort((a, b) => a - b);
    for (const c of small) {
      if ((sizes.get(c) || 0) === 0) continue;
      // Weight from members of c to each other community.
      const toOther = new Map();
      for (let i = 0; i < g.length; i++) {
        if (comm[i] !== c) continue;
        for (const [j, w] of g[i]) {
          const cj = comm[j];
          if (cj === c) continue;
          toOther.set(cj, (toOther.get(cj) || 0) + w);
        }
      }
      if (toOther.size === 0) continue; // no edges out; leave it, isolated-style small topic
      let best = null;
      let bestW = -1;
      for (const [cj, w] of [...toOther.entries()].sort((a, b) => a[0] - b[0])) {
        if (w > bestW) { bestW = w; best = cj; }
      }
      for (let i = 0; i < comm.length; i++) if (comm[i] === c) comm[i] = best;
      sizes.set(c, 0);
      sizes.set(best, (sizes.get(best) || 0) + (sizes.get(c) || 0));
      changed = true;
    }
  }
  return comm;
}

function tokenize(text) {
  return (text.toLowerCase().match(/[a-z][a-z']*/g) || []).filter((w) => w.length > 2 && !STOP.has(w));
}

function topicName(members, descriptions) {
  const docFreq = topicName.docFreq; // set by caller once
  const totalDocs = topicName.totalDocs;
  const counts = new Map();
  for (const slug of members) {
    for (const w of tokenize(descriptions[slug] || '')) counts.set(w, (counts.get(w) || 0) + 1);
  }
  const scored = [];
  for (const [w, tf] of counts) {
    const df = docFreq.get(w) || 1;
    const idf = Math.log((totalDocs + 1) / df);
    scored.push([w, tf * idf]);
  }
  // Score desc, then word asc, so a tie never depends on Map iteration order.
  scored.sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : 1));
  const top = scored.slice(0, 3).map(([w]) => w[0].toUpperCase() + w.slice(1));
  if (top.length === 0) return 'Unlinked';
  if (top.length === 1) return top[0];
  if (top.length === 2) return top[0] + ' and ' + top[1];
  return top[0] + ', ' + top[1] + ' and ' + top[2];
}

function main() {
  const emb = loadJSON(join(IDX, 'embeddings.json'));
  const kw = loadJSON(join(IDX, 'keywords.json'));
  const descriptions = kw.descriptions;

  // Fix node order once, by slug, so every later "sort by index" is also "sort by slug".
  const order = emb.slugs.map((s, i) => i).sort((a, b) => (emb.slugs[a] < emb.slugs[b] ? -1 : 1));
  const slugs = order.map((i) => emb.slugs[i]);
  const vectors = order.map((i) => emb.vectors[i]);

  const g = buildGraph(slugs, vectors);
  const n = slugs.length;

  const isolated = new Set();
  for (let i = 0; i < n; i++) if (g[i].size === 0) isolated.add(i);

  let comm = multilevelLouvain(g, RESOLUTION, 6);
  comm = relabel(comm);
  comm = mergeSmall(comm, g, slugs);
  comm = relabel(comm);

  // Isolated nodes always form their own named topic regardless of what Louvain assigned them
  // (a zero-degree node is its own trivial community anyway, so this never fights the algorithm).
  const UNLINKED = Math.max(...comm) + 1;
  for (const i of isolated) comm[i] = UNLINKED;

  // Word document frequency across ALL descriptions, computed once, used by every topic name.
  const docFreq = new Map();
  for (const slug of slugs) {
    const seen = new Set(tokenize(descriptions[slug] || ''));
    for (const w of seen) docFreq.set(w, (docFreq.get(w) || 0) + 1);
  }
  topicName.docFreq = docFreq;
  topicName.totalDocs = slugs.length;

  const weightedDegree = new Float64Array(n);
  for (let i = 0; i < n; i++) { let d = 0; for (const w of g[i].values()) d += w; weightedDegree[i] = d; }

  const byComm = new Map();
  for (let i = 0; i < n; i++) {
    if (!byComm.has(comm[i])) byComm.set(comm[i], []);
    byComm.get(comm[i]).push(i);
  }

  const topics = [];
  for (const [cid, members] of byComm) {
    const memberSlugs = members.map((i) => slugs[i]).sort();
    let hubIdx = members[0];
    for (const i of members) if (weightedDegree[i] > weightedDegree[hubIdx]) hubIdx = i;
    // Tie-break the hub by slug so it never depends on member array order.
    for (const i of members) if (weightedDegree[i] === weightedDegree[hubIdx] && slugs[i] < slugs[hubIdx]) hubIdx = i;
    const name = cid === UNLINKED ? 'Unlinked' : topicName(memberSlugs, descriptions);
    topics.push({ name, size: memberSlugs.length, hub: slugs[hubIdx], members: memberSlugs, _cid: cid });
  }

  // Sort by size desc, ties by name asc, so ids are stable across runs.
  topics.sort((a, b) => (b.size - a.size) || (a.name < b.name ? -1 : 1));

  const of = {};
  topics.forEach((t, id) => { t.id = id; for (const slug of t.members) of[slug] = id; });

  const out = {
    version: 1,
    method: 'louvain',
    topics: topics.map((t) => ({ id: t.id, name: t.name, size: t.size, hub: t.hub })),
    of,
  };

  const lines = [];
  for (const t of out.topics) lines.push(t.id + String.fromCharCode(9) + t.size + String.fromCharCode(9) + t.name + String.fromCharCode(9) + t.hub);
  process.stdout.write(lines.join(String.fromCharCode(10)) + String.fromCharCode(10));
  process.stdout.write('topics: ' + out.topics.length + String.fromCharCode(10));

  if (!CHECK) {
    writeFileSync(join(IDX, 'topics.json'), JSON.stringify(out, null, 2), 'utf8');
  }
}

main();
